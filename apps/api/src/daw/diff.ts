import type { ProjectAnalysisManifest, RevisionDiff } from "./types.js";

export const diffProjectAnalysis = (
  fromRevisionId: string,
  toRevisionId: string,
  fromAnalysis: ProjectAnalysisManifest,
  toAnalysis: ProjectAnalysisManifest
): RevisionDiff => {
  const fromByName = new Map(fromAnalysis.tracks.map((track) => [track.name, track]));
  const toByName = new Map(toAnalysis.tracks.map((track) => [track.name, track]));

  const tracksAdded: string[] = [];
  const tracksRemoved: string[] = [];
  const tracksRenamed: Array<{ from: string; to: string }> = [];

  for (const name of toByName.keys()) {
    if (!fromByName.has(name)) {
      tracksAdded.push(name);
    }
  }
  for (const name of fromByName.keys()) {
    if (!toByName.has(name)) {
      tracksRemoved.push(name);
    }
  }

  const fromPlugins = new Set(fromAnalysis.pluginsSummary.map((p) => p.name));
  const toPlugins = new Set(toAnalysis.pluginsSummary.map((p) => p.name));
  const pluginsAdded = [...toPlugins].filter((name) => !fromPlugins.has(name));
  const pluginsRemoved = [...fromPlugins].filter((name) => !toPlugins.has(name));

  const diff: RevisionDiff = {
    fromRevisionId,
    toRevisionId,
    tracksAdded,
    tracksRemoved,
    tracksRenamed,
    pluginsAdded,
    pluginsRemoved
  };

  if (fromAnalysis.tempo !== toAnalysis.tempo) {
    diff.tempoChanged = { from: fromAnalysis.tempo, to: toAnalysis.tempo };
  }

  return diff;
};
