export type DawKind = "ableton" | "flstudio";

export type ParseJobStatus = "queued" | "parsing" | "ready" | "failed";

export type ProjectPluginFormat = "native" | "vst2" | "vst3" | "au" | "max" | "unknown";

export type ProjectPlugin = {
  name: string;
  vendor?: string;
  format: ProjectPluginFormat;
};

export type ProjectClip = {
  name: string;
  startBar: number;
  endBar: number;
  color?: string;
};

export type ProjectTrackType = "audio" | "midi" | "group" | "return" | "master";

export type ProjectTrack = {
  id: string;
  name: string;
  type: ProjectTrackType;
  color?: string;
  mute: boolean;
  solo: boolean;
  plugins: ProjectPlugin[];
  clips: ProjectClip[];
};

export type ProjectPluginSummary = {
  name: string;
  vendor?: string;
  format: ProjectPluginFormat;
  usedOnTracks: string[];
};

export type ProjectWarning = {
  code: string;
  message: string;
};

export type ProjectAnalysisManifest = {
  daw: DawKind;
  dawVersionHint?: string;
  projectName: string;
  tempo?: number;
  timeSignature?: { numerator: number; denominator: number };
  lengthBars?: number;
  tracks: ProjectTrack[];
  pluginsSummary: ProjectPluginSummary[];
  warnings: ProjectWarning[];
  sourceFile: {
    name: string;
    sha256: string;
    sizeBytes: number;
  };
  parsedAt: string;
};

export type StoredDawProject = {
  id: string;
  name: string;
  ownerId: string;
  daw: DawKind;
  createdAt: string;
  lastActiveAt: string;
};

export type StoredDawRevision = {
  id: string;
  projectId: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  status: ParseJobStatus;
  error?: string;
  storageKey: string;
  analysisKey?: string;
  createdAt: string;
  parsedAt?: string;
};

export type SessionProjectBinding = {
  sessionId: string;
  projectId: string;
  revisionId: string;
  boundAt: string;
  boundBy: string;
};

export type RevisionDiff = {
  fromRevisionId: string;
  toRevisionId: string;
  tracksAdded: string[];
  tracksRemoved: string[];
  tracksRenamed: Array<{ from: string; to: string }>;
  pluginsAdded: string[];
  pluginsRemoved: string[];
  tempoChanged?: { from?: number; to?: number };
};

export type DawProjectSummary = StoredDawProject & {
  latestRevision?: StoredDawRevision;
  revisionCount: number;
};
