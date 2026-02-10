export type ParticipantManifest = {
  identity: string;
  name?: string;
};

export type TrackManifest = {
  participantIdentity: string;
  participantName?: string;
  kind: "audio";
  url: string;
  startOffsetMs: number;
};

export type SessionManifest = {
  sessionId: string;
  room: string;
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
  startedAt: string;
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
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  participants: session.participants,
  tracks: session.tracks.map((track) => ({
    participantIdentity: track.participantIdentity,
    participantName: track.participantName,
    kind: "audio",
    url: track.url,
    startOffsetMs: toOffsetMs(session.startedAt, track.startedAt)
  })),
  masterMixUrl: session.masterMixUrl
});
