export type DawKind = "ableton" | "flstudio";

export type ProjectPluginSummary = {
  name: string;
  vendor?: string;
  format: string;
  usedOnTracks: string[];
};

export type ProjectTrack = {
  id: string;
  name: string;
  type: string;
  color?: string;
  mute: boolean;
  solo: boolean;
  plugins: Array<{ name: string; vendor?: string; format: string }>;
  clips: Array<{ name: string; startBar: number; endBar: number; color?: string }>;
};

export type ProjectAnalysisManifest = {
  daw: DawKind;
  projectName: string;
  tempo?: number;
  timeSignature?: { numerator: number; denominator: number };
  lengthBars?: number;
  tracks: ProjectTrack[];
  pluginsSummary: ProjectPluginSummary[];
  warnings: Array<{ code: string; message: string }>;
  sourceFile: {
    name: string;
    sha256: string;
    sizeBytes: number;
  };
};

export type SessionProjectInfo = {
  projectName: string;
  daw: DawKind;
  revisionId: string;
  fileName: string;
};
