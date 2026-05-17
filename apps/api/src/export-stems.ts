import type { SessionManifest } from "./manifest.js";

export type StemExportEntry = {
  participantIdentity: string;
  participantName?: string;
  channel?: string;
  trackId?: string;
  url: string;
  fileName: string;
};

export const buildStemExportManifest = (manifest: SessionManifest) => {
  const stems: StemExportEntry[] = manifest.tracks.map((track) => {
    const channelPart = track.channel ? `${track.channel.toLowerCase()}-` : "";
    const trackPart = track.trackId ?? "audio";
    const fileName = `${track.participantIdentity}-${channelPart}${trackPart}.${track.container}`;
    return {
      participantIdentity: track.participantIdentity,
      participantName: track.participantName,
      channel: track.channel,
      trackId: track.trackId,
      url: track.url,
      fileName
    };
  });

  return {
    sessionId: manifest.sessionId,
    room: manifest.room,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    syncMode: manifest.syncMode,
    projectName: manifest.projectName,
    daw: manifest.daw,
    stems,
    loops: manifest.loops ?? [],
    roomMixLoops: manifest.roomMixLoops ?? [],
    overdubs: manifest.overdubs ?? []
  };
};
