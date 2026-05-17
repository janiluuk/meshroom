import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "path";
import type { AppConfig } from "../config.js";
import type { Store, StoredUser } from "../store.js";
import { createTimeshiftService } from "../timeshift.js";
import { formatPluginChecklistMarkdown, formatPluginChecklistPlain } from "./checklist.js";
import { diffProjectAnalysis } from "./diff.js";
import { detectDawFromFileName, parseAlsBuffer } from "./parse-als.js";
import { parseFlpBuffer } from "./parse-flp.js";
import { createProjectStore, type ProjectStore } from "./project-store.js";
import { createHash } from "crypto";
import { createDawStorage, revisionAnalysisKey, revisionOriginalKey } from "./storage.js";
import fs from "fs";
import type {
  DawKind,
  ProjectAnalysisManifest,
  SessionProjectBinding,
  StoredDawProject,
  StoredDawRevision
} from "./types.js";

type S3ClientLike = {
  send: (command: unknown) => Promise<unknown>;
};

type RegisterDawRoutesOptions = {
  store: Store;
  s3Client: S3ClientLike;
  now: () => Date;
  projectStore?: ProjectStore;
};

export type BindSessionProjectResult = {
  binding: SessionProjectBinding;
  project: StoredDawProject;
  revision: StoredDawRevision;
  analysis: ProjectAnalysisManifest | null;
};

const extForDaw = (daw: DawKind) => (daw === "ableton" ? "als" : "flp");

const runParse = async (
  buffer: Buffer,
  fileName: string,
  daw: DawKind,
  parsedAt: string,
  config: AppConfig
): Promise<ProjectAnalysisManifest> => {
  if (daw === "ableton") {
    return parseAlsBuffer(buffer, fileName, parsedAt);
  }
  return parseFlpBuffer(buffer, fileName, parsedAt, {
    parserScript: config.daw.flpParserScript || undefined
  });
};

const writeTimeshiftProject = (
  config: AppConfig,
  sessionId: string,
  payload: Record<string, unknown>
) => {
  const timeshift = createTimeshiftService({
    baseDir: config.daw.timeshiftDir,
    startDir: process.cwd()
  });
  if (!timeshift.enabled) {
    return;
  }
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  const sessionDir = path.join(timeshift.baseDir, safeId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "project.json"), JSON.stringify(payload, null, 2));
};

export const registerDawRoutes = async (
  server: FastifyInstance,
  config: AppConfig,
  options: RegisterDawRoutesOptions
) => {
  await server.register(multipart, {
    limits: { fileSize: config.daw.maxUploadBytes }
  });

  const projectStore =
    options.projectStore ??
    createProjectStore({
      filePath: config.daw.projectsStorePath,
      now: options.now,
      maxRevisionsPerProject: config.daw.maxRevisionsPerProject
    });
  const dawStorage = createDawStorage(options.s3Client as import("@aws-sdk/client-s3").S3Client, {
    bucket: config.minio.bucket,
    publicUrl: config.minio.publicUrl
  });

  const getUser = (request: FastifyRequest) =>
    (request as FastifyRequest & { user?: StoredUser }).user ?? null;

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header || Array.isArray(header)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const user = options.store.getUserByToken(token);
    if (!user) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    (request as FastifyRequest & { user?: StoredUser }).user = user;
  };

  const canAccessProject = (user: StoredUser, projectId: string) => {
    const project = projectStore.getProject(projectId);
    return Boolean(project && project.ownerId === user.id);
  };

  const canAccessSession = (user: StoredUser, sessionId: string) =>
    Boolean(options.store.getMembership(user.id, sessionId));

  const canManageSessionProject = (user: StoredUser, sessionId: string) => {
    const membership = options.store.getMembership(user.id, sessionId);
    return membership?.role === "master" || options.store.isSessionOwner(user.id, sessionId);
  };

  const loadAnalysis = async (revision: StoredDawRevision) => {
    if (!revision.analysisKey) {
      return null;
    }
    return dawStorage.getAnalysis(revision.analysisKey);
  };

  const bindSessionProject = async (
    sessionId: string,
    projectId: string,
    revisionId: string,
    userId: string
  ): Promise<BindSessionProjectResult | { error: string; statusCode: number }> => {
    const project = projectStore.getProject(projectId);
    const revision = projectStore.getRevision(revisionId);
    if (!project || !revision || revision.projectId !== projectId) {
      return { error: "project or revision not found", statusCode: 404 };
    }
    if (project.ownerId !== userId) {
      return { error: "only project owner can bind", statusCode: 403 };
    }
    const binding = projectStore.bindSession(sessionId, projectId, revisionId, userId);
    writeTimeshiftProject(config, sessionId, {
      projectId,
      revisionId,
      daw: project.daw,
      boundAt: binding.boundAt
    });
    const analysis = revision.status === "ready" ? await loadAnalysis(revision) : null;
    return { binding, project, revision, analysis };
  };

  const processRevision = async (revisionId: string, buffer: Buffer, fileName: string, daw: DawKind) => {
    const revision = projectStore.getRevision(revisionId);
    if (!revision) {
      return;
    }
    projectStore.updateRevision(revisionId, { status: "parsing" });
    try {
      const analysis = await runParse(buffer, fileName, daw, options.now().toISOString());
      const analysisKey = revisionAnalysisKey(revision.projectId, revisionId);
      await dawStorage.putAnalysis(analysisKey, analysis);
      projectStore.updateRevision(revisionId, {
        status: "ready",
        analysisKey,
        parsedAt: analysis.parsedAt,
        error: undefined
      });
    } catch (error) {
      projectStore.updateRevision(revisionId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Parse failed"
      });
    }
  };

  server.post("/projects", { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;
    const body = request.body as { name?: string; daw?: DawKind };
    const name = body?.name?.trim();
    const daw = body?.daw;
    if (!name) {
      reply.code(400).send({ error: "name is required" });
      return;
    }
    if (daw !== "ableton" && daw !== "flstudio") {
      reply.code(400).send({ error: "daw must be ableton or flstudio" });
      return;
    }
    const project = projectStore.createProject(user.id, name, daw);
    reply.send({ project });
  });

  server.get("/projects", { preHandler: requireAuth }, async (request) => {
    const user = getUser(request)!;
    return { projects: projectStore.listProjectsForUser(user.id) };
  });

  server.get("/projects/:id", { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;
    const projectId = (request.params as { id: string }).id;
    if (!canAccessProject(user, projectId)) {
      reply.code(404).send({ error: "project not found" });
      return;
    }
    const project = projectStore.getProject(projectId)!;
    const revisions = projectStore.listRevisions(projectId);
    reply.send({
      project,
      latestRevision: revisions[0] ?? null,
      revisionCount: revisions.length
    });
  });

  server.get("/projects/:id/revisions", { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;
    const projectId = (request.params as { id: string }).id;
    if (!canAccessProject(user, projectId)) {
      reply.code(404).send({ error: "project not found" });
      return;
    }
    reply.send({ revisions: projectStore.listRevisions(projectId) });
  });

  server.post("/projects/:id/revisions", { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;
    const projectId = (request.params as { id: string }).id;
    const project = projectStore.getProject(projectId);
    if (!project || project.ownerId !== user.id) {
      reply.code(404).send({ error: "project not found" });
      return;
    }

    const file = await request.file();
    if (!file) {
      reply.code(400).send({ error: "file is required (multipart)" });
      return;
    }
    const buffer = await file.toBuffer();
    if (buffer.length > config.daw.maxUploadBytes) {
      reply.code(413).send({ error: `file exceeds ${config.daw.maxUploadBytes} bytes` });
      return;
    }
    const fileName = file.filename || `upload.${extForDaw(project.daw)}`;
    const detected = detectDawFromFileName(fileName);
    if (detected && detected !== project.daw) {
      reply.code(400).send({ error: `project expects .${extForDaw(project.daw)} files` });
      return;
    }

    const ext = extForDaw(project.daw);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const revision = projectStore.addRevision({
      projectId,
      fileName,
      sha256,
      sizeBytes: buffer.length,
      status: "queued",
      storageKey: ""
    });
    const storageKey = revisionOriginalKey(projectId, revision.id, ext);
    await dawStorage.putOriginal(storageKey, buffer, "application/octet-stream");
    projectStore.updateRevision(revision.id, { storageKey, status: "queued" });

    void processRevision(revision.id, buffer, fileName, project.daw);

    reply.code(202).send({ revision: projectStore.getRevision(revision.id) });
  });

  server.get(
    "/projects/:id/revisions/:rev",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { id: projectId, rev: revisionId } = request.params as { id: string; rev: string };
      if (!canAccessProject(user, projectId)) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      const revision = projectStore.getRevision(revisionId);
      if (!revision || revision.projectId !== projectId) {
        reply.code(404).send({ error: "revision not found" });
        return;
      }
      reply.send({ revision });
    }
  );

  server.get(
    "/projects/:id/revisions/:rev/analysis",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { id: projectId, rev: revisionId } = request.params as { id: string; rev: string };
      if (!canAccessProject(user, projectId)) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      const revision = projectStore.getRevision(revisionId);
      if (!revision || revision.projectId !== projectId) {
        reply.code(404).send({ error: "revision not found" });
        return;
      }
      if (revision.status === "failed") {
        reply.code(422).send({ error: revision.error ?? "parse failed" });
        return;
      }
      if (revision.status !== "ready") {
        reply.code(202).send({ status: revision.status, revision });
        return;
      }
      const analysis = await loadAnalysis(revision);
      if (!analysis) {
        reply.code(404).send({ error: "analysis not found" });
        return;
      }
      reply.send({ analysis, revision });
    }
  );

  server.get(
    "/projects/:id/revisions/:rev/diff/:otherRev",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { id: projectId, rev, otherRev } = request.params as {
        id: string;
        rev: string;
        otherRev: string;
      };
      if (!canAccessProject(user, projectId)) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      const fromRevision = projectStore.getRevision(rev);
      const toRevision = projectStore.getRevision(otherRev);
      if (
        !fromRevision ||
        !toRevision ||
        fromRevision.projectId !== projectId ||
        toRevision.projectId !== projectId
      ) {
        reply.code(404).send({ error: "revision not found" });
        return;
      }
      const fromAnalysis = await loadAnalysis(fromRevision);
      const toAnalysis = await loadAnalysis(toRevision);
      if (!fromAnalysis || !toAnalysis) {
        reply.code(422).send({ error: "analysis not ready" });
        return;
      }
      reply.send({
        diff: diffProjectAnalysis(rev, otherRev, fromAnalysis, toAnalysis)
      });
    }
  );

  server.get(
    "/projects/:id/revisions/:rev/download",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { id: projectId, rev: revisionId } = request.params as { id: string; rev: string };
      if (!canAccessProject(user, projectId)) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      const revision = projectStore.getRevision(revisionId);
      if (!revision || revision.projectId !== projectId) {
        reply.code(404).send({ error: "revision not found" });
        return;
      }
      const url = await dawStorage.presignedDownloadUrl(revision.storageKey);
      reply.send({ url, fileName: revision.fileName });
    }
  );

  server.get(
    "/projects/:id/revisions/:rev/checklist",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request)!;
      const { id: projectId, rev: revisionId } = request.params as { id: string; rev: string };
      if (!canAccessProject(user, projectId)) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      const revision = projectStore.getRevision(revisionId);
      if (!revision || revision.projectId !== projectId) {
        reply.code(404).send({ error: "revision not found" });
        return;
      }
      if (revision.status !== "ready") {
        reply.code(202).send({ status: revision.status });
        return;
      }
      const analysis = await loadAnalysis(revision);
      if (!analysis) {
        reply.code(404).send({ error: "analysis not found" });
        return;
      }
      reply.send({
        markdown: formatPluginChecklistMarkdown(analysis),
        plain: formatPluginChecklistPlain(analysis),
        pluginCount: analysis.pluginsSummary.length
      });
    }
  );

  server.post("/sessions/:id/project", { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;
    const sessionId = (request.params as { id: string }).id;
    const body = request.body as { projectId?: string; revisionId?: string };
    if (!canManageSessionProject(user, sessionId)) {
      reply.code(403).send({ error: "master role required" });
      return;
    }
    const projectId = body?.projectId?.trim();
    const revisionId = body?.revisionId?.trim();
    if (!projectId || !revisionId) {
      reply.code(400).send({ error: "projectId and revisionId are required" });
      return;
    }
    const result = await bindSessionProject(sessionId, projectId, revisionId, user.id);
    if ("error" in result) {
      reply.code(result.statusCode).send({ error: result.error });
      return;
    }
    reply.send(result);
  });

  server.get("/sessions/:id/project", { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;
    const sessionId = (request.params as { id: string }).id;
    if (!canAccessSession(user, sessionId)) {
      reply.code(403).send({ error: "join session to view project" });
      return;
    }
    const binding = projectStore.getSessionBinding(sessionId);
    if (!binding) {
      reply.code(404).send({ error: "no project bound to session" });
      return;
    }
    const project = projectStore.getProject(binding.projectId);
    const revision = projectStore.getRevision(binding.revisionId);
    if (!project || !revision) {
      reply.code(404).send({ error: "bound project missing" });
      return;
    }
    const analysis = revision.status === "ready" ? await loadAnalysis(revision) : null;
    let downloadUrl: string | null = null;
    if (revision.status === "ready" && revision.storageKey) {
      try {
        downloadUrl = await dawStorage.presignedDownloadUrl(revision.storageKey);
      } catch {
        downloadUrl = dawStorage.publicUrlForKey(revision.storageKey);
      }
    }
    reply.send({ binding, project, revision, analysis, downloadUrl });
  });

  server.get("/sessions/:id/project/checklist", { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;
    const sessionId = (request.params as { id: string }).id;
    if (!canAccessSession(user, sessionId)) {
      reply.code(403).send({ error: "join session to view project" });
      return;
    }
    const binding = projectStore.getSessionBinding(sessionId);
    if (!binding) {
      reply.code(404).send({ error: "no project bound to session" });
      return;
    }
    const revision = projectStore.getRevision(binding.revisionId);
    if (!revision || revision.status !== "ready") {
      reply.code(422).send({ error: "analysis not ready" });
      return;
    }
    const analysis = await loadAnalysis(revision);
    if (!analysis) {
      reply.code(404).send({ error: "analysis not found" });
      return;
    }
    reply.send({
      markdown: formatPluginChecklistMarkdown(analysis),
      plain: formatPluginChecklistPlain(analysis),
      pluginCount: analysis.pluginsSummary.length
    });
  });

  server.delete("/sessions/:id/project", { preHandler: requireAuth }, async (request, reply) => {
    const user = getUser(request)!;
    const sessionId = (request.params as { id: string }).id;
    if (!canManageSessionProject(user, sessionId)) {
      reply.code(403).send({ error: "master role required" });
      return;
    }
    if (!projectStore.unbindSession(sessionId)) {
      reply.code(404).send({ error: "no project bound" });
      return;
    }
    reply.send({ ok: true });
  });

  return { projectStore, bindSessionProject };
};
