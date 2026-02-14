import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { SessionManifest } from "./manifest";

export type TimeshiftStatePayload = {
  mappings?: Record<string, unknown>;
  loops?: Record<string, unknown>;
  overdubs?: Record<string, unknown>;
};

export type TimeshiftSnapshot = {
  id: string;
  message: string;
  createdAt: string;
  files: string[];
};

type TimeshiftWriteInput = {
  manifest?: SessionManifest | null;
  state?: TimeshiftStatePayload | null;
};

type TimeshiftService = {
  enabled: boolean;
  baseDir: string;
  writeSessionFiles: (sessionId: string, input: TimeshiftWriteInput) => Promise<void>;
  snapshotSession: (
    sessionId: string,
    message: string,
    input?: TimeshiftWriteInput
  ) => Promise<{ committed: boolean; commitId?: string }>;
  listSnapshots: (sessionId: string) => Promise<TimeshiftSnapshot[]>;
  restoreSnapshot: (
    sessionId: string,
    commitId: string
  ) => Promise<{ safetyCommitId?: string; restoreCommitId?: string }>;
  readManifest: (sessionId: string) => SessionManifest | null;
};

type TimeshiftOptions = {
  baseDir: string;
  startDir?: string;
  logger?: {
    info: (data: Record<string, unknown>, msg?: string) => void;
    warn: (data: Record<string, unknown>, msg?: string) => void;
  };
};

const execFileAsync = promisify(execFile);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "RemoteDJ",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "remote-dj@local",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "RemoteDJ",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "remote-dj@local"
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const findRepoRoot = (startDir: string): string | null => {
  let current = path.resolve(startDir);
  while (current) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
};

const safeSessionId = (sessionId: string) =>
  sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

const ensureWithinRoot = (root: string, target: string) => {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Timeshift path escapes repository root");
  }
};

const writeJsonFile = (filePath: string, data: unknown) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

const runGit = async (repoRoot: string, args: string[]) => {
  const result = await execFileAsync("git", args, { cwd: repoRoot, env: gitEnv });
  return result.stdout.toString().trim();
};

const buildReferences = (manifest: SessionManifest | null) => {
  if (!manifest) {
    return null;
  }
  return {
    tracks: manifest.tracks.map((track) => ({
      participantIdentity: track.participantIdentity,
      participantName: track.participantName,
      trackId: track.trackId,
      channel: track.channel,
      url: track.url,
      container: track.container,
      codec: track.codec,
      startedAt: track.startedAt,
      endedAt: track.endedAt
    })),
    loops: manifest.loops ?? [],
    roomMixLoops: manifest.roomMixLoops ?? [],
    overdubs: manifest.overdubs ?? [],
    masterMixUrl: manifest.masterMixUrl ?? null
  };
};

export const createTimeshiftService = ({
  baseDir,
  startDir = process.cwd(),
  logger
}: TimeshiftOptions): TimeshiftService => {
  const repoRoot = findRepoRoot(startDir);
  if (!repoRoot) {
    logger?.warn({ startDir }, "Timeshift disabled: repository root not found");
    return {
      enabled: false,
      baseDir: baseDir,
      writeSessionFiles: async () => undefined,
      snapshotSession: async () => ({ committed: false }),
      listSnapshots: async () => [],
      restoreSnapshot: async () => ({}),
      readManifest: () => null
    };
  }

  const resolvedBaseDir = path.isAbsolute(baseDir) ? baseDir : path.join(repoRoot, baseDir);
  ensureWithinRoot(repoRoot, resolvedBaseDir);

  const sessionDirFor = (sessionId: string) => {
    const safeId = safeSessionId(sessionId);
    return path.join(resolvedBaseDir, safeId);
  };

  const sessionRelPath = (sessionId: string) => {
    const dir = sessionDirFor(sessionId);
    ensureWithinRoot(repoRoot, dir);
    return path.relative(repoRoot, dir);
  };

  const readManifest = (sessionId: string): SessionManifest | null => {
    const filePath = path.join(sessionDirFor(sessionId), "session.json");
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return raw ? (JSON.parse(raw) as SessionManifest) : null;
    } catch (error) {
      return null;
    }
  };

  const writeSessionFiles = async (sessionId: string, input: TimeshiftWriteInput) => {
    const sessionDir = sessionDirFor(sessionId);
    ensureWithinRoot(repoRoot, sessionDir);
    const manifest = input.manifest ?? readManifest(sessionId);
    const state = input.state;

    if (manifest) {
      writeJsonFile(path.join(sessionDir, "session.json"), manifest);
    }

    if (state?.mappings && isPlainObject(state.mappings)) {
      writeJsonFile(path.join(sessionDir, "mappings.json"), state.mappings);
    } else if (!fs.existsSync(path.join(sessionDir, "mappings.json"))) {
      writeJsonFile(path.join(sessionDir, "mappings.json"), {});
    }

    const loopsFile = {
      recorded: {
        loops: manifest?.loops ?? [],
        roomMixLoops: manifest?.roomMixLoops ?? []
      },
      definitions: state?.loops ?? null
    };
    writeJsonFile(path.join(sessionDir, "loops.json"), loopsFile);

    const overdubsFile = {
      recorded: manifest?.overdubs ?? [],
      metadata: state?.overdubs ?? null
    };
    writeJsonFile(path.join(sessionDir, "overdubs.json"), overdubsFile);

    const references = buildReferences(manifest);
    if (references) {
      writeJsonFile(path.join(sessionDir, "references.json"), references);
    }
  };

  const commitSessionFiles = async (sessionId: string, message: string) => {
    const relPath = sessionRelPath(sessionId);
    const status = await runGit(repoRoot, ["status", "--porcelain", "--", relPath]);
    if (!status) {
      return { committed: false };
    }
    await runGit(repoRoot, ["add", relPath]);
    await runGit(repoRoot, ["commit", "-m", message, "--", relPath]);
    const commitId = await runGit(repoRoot, ["rev-parse", "HEAD"]);
    return { committed: true, commitId };
  };

  const snapshotSession = async (
    sessionId: string,
    message: string,
    input?: TimeshiftWriteInput
  ) => {
    if (input) {
      await writeSessionFiles(sessionId, input);
    }
    const commitMessage = `timeshift(${sessionId}): ${message}`;
    return commitSessionFiles(sessionId, commitMessage);
  };

  const listSnapshots = async (sessionId: string) => {
    const relPath = sessionRelPath(sessionId);
    const output = await runGit(repoRoot, [
      "log",
      "--pretty=format:%H%x1f%ad%x1f%s",
      "--date=iso",
      "--",
      relPath
    ]);
    if (!output) {
      return [];
    }
    const entries = output.split("\n").map((line) => {
      const [id, createdAt, message] = line.split("\x1f");
      return { id, createdAt, message };
    });

    const snapshots: TimeshiftSnapshot[] = [];
    for (const entry of entries) {
      const diffOutput = await runGit(repoRoot, [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        entry.id,
        "--",
        relPath
      ]);
      const files = diffOutput
        ? diffOutput
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [status, filePath] = line.split(/\s+/);
              const trimmedPath = filePath?.startsWith(relPath)
                ? filePath.slice(relPath.length + 1)
                : filePath;
              return `${status} ${trimmedPath ?? ""}`.trim();
            })
        : [];
      snapshots.push({
        id: entry.id,
        createdAt: entry.createdAt,
        message: entry.message,
        files
      });
    }

    return snapshots;
  };

  const restoreSnapshot = async (sessionId: string, commitId: string) => {
    const relPath = sessionRelPath(sessionId);
    const safety = await snapshotSession(sessionId, "safety snapshot before restore");
    await runGit(repoRoot, ["checkout", commitId, "--", relPath]);
    const restore = await commitSessionFiles(sessionId, `timeshift(${sessionId}): restore ${commitId}`);
    return { safetyCommitId: safety.commitId, restoreCommitId: restore.commitId };
  };

  return {
    enabled: true,
    baseDir: resolvedBaseDir,
    writeSessionFiles,
    snapshotSession,
    listSnapshots,
    restoreSnapshot,
    readManifest
  };
};
