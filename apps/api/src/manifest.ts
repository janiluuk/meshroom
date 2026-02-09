export type ReconnectMarker = {
  startedAt: string;
  endedAt?: string;
  reason?: string;
};

export type TrackManifest = {
  trackId: string;
  kind: string;
  url: string;
  container: string;
  codec: string;
  startedAt: string;
  endedAt?: string;
  reconnectMarkers: ReconnectMarker[];
};

export type ParticipantManifest = {
  identity: string;
  tracks: TrackManifest[];
};

export type SessionManifest = {
  sessionId: string;
  roomName: string;
  startedAt: string;
  endedAt?: string;
  participants: ParticipantManifest[];
};

export type ActiveTrack = TrackManifest & {
  egressId: string;
  fileKey: string;
};

export type ActiveParticipant = {
  identity: string;
  tracks: ActiveTrack[];
};

export type ActiveSession = Omit<SessionManifest, "participants"> & {
  participants: ActiveParticipant[];
};

export const toManifest = (session: ActiveSession): SessionManifest => ({
  sessionId: session.sessionId,
  roomName: session.roomName,
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  participants: session.participants.map((participant) => ({
    identity: participant.identity,
    tracks: participant.tracks.map((track) => ({
      trackId: track.trackId,
      kind: track.kind,
      url: track.url,
      container: track.container,
      codec: track.codec,
      startedAt: track.startedAt,
      endedAt: track.endedAt,
      reconnectMarkers: track.reconnectMarkers
    }))
  }))
});
