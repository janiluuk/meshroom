export type ParticipantManifest = {
  identity: string;
  name?: string;
};

export type ReconnectMarker = {
  at: string;
  reason?: string;
};

export type AudioChannelRole = "MUSIC_IN" | "VOICE" | "MIX";

export type TrackManifest = {
  participantIdentity: string;
  participantName?: string;
  kind: "audio";
  trackId?: string;
  channel?: AudioChannelRole;
  url: string;
  container: string;
  codec: string;
  startedAt: string;
  endedAt?: string;
  reconnects: ReconnectMarker[];
  startOffsetMs: number;
};

export type SyncMode = "LINK_LAN" | "LINK_WAN" | "MIDI";

export type SyncTimelineEntry = {
  at: string;
  mode: SyncMode;
  tempo?: number;
};

export type LoopMarker = {
  id: string;
  participantIdentity?: string;
  startBar?: number;
  endBar?: number;
  label?: string;
};

export type OverdubMarker = {
  id: string;
  participantIdentity?: string;
  at: string;
  label?: string;
};

export type SessionManifest = {
  sessionId: string;
  room: string;
  syncMode: SyncMode;
  syncTimeline?: SyncTimelineEntry[];
  startedAt: string;
  endedAt?: string;
  bpm?: number;
  quantization?: number;
  participants: ParticipantManifest[];
  tracks: TrackManifest[];
  loops?: LoopMarker[];
  roomMixLoops?: LoopMarker[];
  overdubs?: OverdubMarker[];
  masterMixUrl?: string;
  projectRevisionId?: string;
  projectId?: string;
  daw?: "ableton" | "flstudio";
  projectName?: string;
};

export type ActiveTrack = TrackManifest & {
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
  syncTimeline: session.syncTimeline,
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  bpm: session.bpm,
  quantization: session.quantization,
  participants: session.participants,
  projectRevisionId: session.projectRevisionId,
  projectId: session.projectId,
  daw: session.daw,
  projectName: session.projectName,
  loops: session.loops ?? [],
  roomMixLoops: session.roomMixLoops ?? [],
  overdubs: session.overdubs ?? [],
  tracks: session.tracks.map((track) => ({
    participantIdentity: track.participantIdentity,
    participantName: track.participantName,
    kind: "audio",
    trackId: track.trackId,
    channel: track.channel,
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

export const inferAudioChannel = (audioIndex: number, totalAudio: number): AudioChannelRole => {
  if (totalAudio <= 1) {
    return "MIX";
  }
  return audioIndex === 0 ? "MUSIC_IN" : "VOICE";
};
