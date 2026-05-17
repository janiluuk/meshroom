import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type {
  DawKind,
  DawProjectSummary,
  ParseJobStatus,
  SessionProjectBinding,
  StoredDawProject,
  StoredDawRevision
} from "./types.js";

export type ProjectStoreData = {
  projects: StoredDawProject[];
  revisions: StoredDawRevision[];
  sessionBindings: SessionProjectBinding[];
};

const emptyData = (): ProjectStoreData => ({
  projects: [],
  revisions: [],
  sessionBindings: []
});

export type ProjectStoreOptions = {
  filePath: string;
  now?: () => Date;
  maxRevisionsPerProject?: number;
};

export type ProjectStore = {
  createProject: (ownerId: string, name: string, daw: DawKind) => StoredDawProject;
  listProjectsForUser: (ownerId: string) => DawProjectSummary[];
  getProject: (projectId: string) => StoredDawProject | null;
  listRevisions: (projectId: string) => StoredDawRevision[];
  getRevision: (revisionId: string) => StoredDawRevision | null;
  addRevision: (input: Omit<StoredDawRevision, "id" | "createdAt">) => StoredDawRevision;
  updateRevision: (
    revisionId: string,
    patch: Partial<Pick<StoredDawRevision, "status" | "error" | "analysisKey" | "parsedAt">>
  ) => StoredDawRevision | null;
  bindSession: (sessionId: string, projectId: string, revisionId: string, userId: string) => SessionProjectBinding;
  unbindSession: (sessionId: string) => boolean;
  getSessionBinding: (sessionId: string) => SessionProjectBinding | null;
  countRevisions: (projectId: string) => number;
};

export const createProjectStore = ({
  filePath,
  now = () => new Date(),
  maxRevisionsPerProject = 50
}: ProjectStoreOptions): ProjectStore => {
  const resolvedPath = path.resolve(filePath);
  let data: ProjectStoreData = emptyData();

  const load = () => {
    if (!fs.existsSync(resolvedPath)) {
      const dir = path.dirname(resolvedPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolvedPath, JSON.stringify(data, null, 2));
      return;
    }
    data = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as ProjectStoreData;
  };

  const save = () => {
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${resolvedPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, resolvedPath);
  };

  load();

  const toIso = () => now().toISOString();

  const summarize = (project: StoredDawProject): DawProjectSummary => {
    const revisions = data.revisions
      .filter((revision) => revision.projectId === project.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      ...project,
      latestRevision: revisions[0],
      revisionCount: revisions.length
    };
  };

  return {
    createProject: (ownerId, name, daw) => {
      const timestamp = toIso();
      const project: StoredDawProject = {
        id: randomUUID(),
        name: name.trim(),
        ownerId,
        daw,
        createdAt: timestamp,
        lastActiveAt: timestamp
      };
      data.projects.push(project);
      save();
      return project;
    },
    listProjectsForUser: (ownerId) =>
      data.projects
        .filter((project) => project.ownerId === ownerId)
        .map(summarize)
        .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)),
    getProject: (projectId) => data.projects.find((project) => project.id === projectId) ?? null,
    listRevisions: (projectId) =>
      data.revisions
        .filter((revision) => revision.projectId === projectId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    getRevision: (revisionId) => data.revisions.find((revision) => revision.id === revisionId) ?? null,
    addRevision: (input) => {
      const count = data.revisions.filter((revision) => revision.projectId === input.projectId).length;
      if (count >= maxRevisionsPerProject) {
        throw new Error(`Revision limit reached (${maxRevisionsPerProject})`);
      }
      const revision: StoredDawRevision = {
        ...input,
        id: randomUUID(),
        createdAt: toIso()
      };
      data.revisions.push(revision);
      const project = data.projects.find((entry) => entry.id === input.projectId);
      if (project) {
        project.lastActiveAt = revision.createdAt;
      }
      save();
      return revision;
    },
    updateRevision: (revisionId, patch) => {
      const revision = data.revisions.find((entry) => entry.id === revisionId);
      if (!revision) {
        return null;
      }
      Object.assign(revision, patch);
      save();
      return revision;
    },
    bindSession: (sessionId, projectId, revisionId, userId) => {
      data.sessionBindings = data.sessionBindings.filter((entry) => entry.sessionId !== sessionId);
      const binding: SessionProjectBinding = {
        sessionId,
        projectId,
        revisionId,
        boundAt: toIso(),
        boundBy: userId
      };
      data.sessionBindings.push(binding);
      save();
      return binding;
    },
    unbindSession: (sessionId) => {
      const before = data.sessionBindings.length;
      data.sessionBindings = data.sessionBindings.filter((entry) => entry.sessionId !== sessionId);
      if (data.sessionBindings.length !== before) {
        save();
        return true;
      }
      return false;
    },
    getSessionBinding: (sessionId) =>
      data.sessionBindings.find((entry) => entry.sessionId === sessionId) ?? null,
    countRevisions: (projectId) =>
      data.revisions.filter((revision) => revision.projectId === projectId).length
  };
};
