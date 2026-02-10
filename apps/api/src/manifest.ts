export type ParticipantManifest = {
  identity: string;
  name?: string;
};

export type ReconnectMarker = {
  at: string;
  reason?: string;
};

export type TrackManifest = {
  participantIdentity: string;
  participantName?: string;
  kind: "audio";
  url: string;
  container: string;
  codec: string;
  startedAt: string;
  endedAt?: string;
  reconnects: ReconnectMarker[];
  startOffsetMs: number;
};

export type SyncMode = "LINK_LAN" | "LINK_WAN" | "MIDI";

export type SessionManifest = {
  sessionId: string;
  room: string;
  syncMode: SyncMode;
  startedAt: string;
  endedAt?: string;
  participants: ParticipantManifest[];
  tracks: TrackManifest[];
  masterMixUrl?: string;
};

export type ActiveTrack = {
  participantIdentity: string;
  participantName?: string;
  kind: "audio";
  url: string;
  container: string;
  codec: string;
  startedAt: string;
  endedAt?: string;
  reconnects: ReconnectMarker[];
  egressId: string;
  fileKey: string;
};

export type ActiveSession = Omit<SessionManifest, "tracks"> & {
  tracks: ActiveTrack[];
};

const toOffsetMs = (sessionStart: string, trackStart: string) => {
  const sessionTime = Date.parse(sessionStart);
  const trackTime = Date.parse(trackStart);
  if (Number.isNaN(sessionTime) || Number.isNaN(trackTime)) {
    return 0;
  }
  return Math.max(trackTime - sessionTime, 0);
};

export const toManifest = (session: ActiveSession): SessionManifest => ({
  sessionId: session.sessionId,
  room: session.room,
  syncMode: session.syncMode,
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  participants: session.participants,
  tracks: session.tracks.map((track) => ({
    participantIdentity: track.participantIdentity,
    participantName: track.participantName,
    kind: "audio",
    url: track.url,
    container: track.container,
    codec: track.codec,
    startedAt: track.startedAt,
    endedAt: track.endedAt,
    reconnects: track.reconnects ?? [],
    startOffsetMs: toOffsetMs(session.startedAt, track.startedAt)
  })),
  masterMixUrl: session.masterMixUrl
});
