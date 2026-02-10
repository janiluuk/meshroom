import Head from "next/head";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionQuality,
  Room,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  type TrackPublication
} from "livekit-client";

type Role = "master" | "peer";
type SyncMode = "LINK_LAN" | "LINK_WAN" | "MIDI";
type MonitorMode = "off" | "room" | "solo";

type AuthUser = {
  id: string;
  displayName: string;
  createdAt: string;
  lastActiveAt: string;
};

type SessionListItem = {
  id: string;
  name: string;
  roomName: string;
  ownerId: string;
  createdAt: string;
  lastActiveAt: string;
  role: Role;
  memberCount: number;
};

type DeviceSnapshot = {
  cam?: string;
  mic?: string;
  output?: string;
};

type MidiLabels = {
  input?: string;
  output?: string;
};

type ParticipantMeta = {
  role?: Role;
  syncMode?: SyncMode;
  devices?: {
    cam?: string;
    mic?: string;
    output?: string;
    midiIn?: string;
    midiOut?: string;
  };
};

type MidiMessageEvent = {
  data: Uint8Array;
};

type MidiInput = {
  id: string;
  name?: string | null;
  onmidimessage: ((event: MidiMessageEvent) => void) | null;
};

type MidiOutput = {
  id: string;
  name?: string | null;
  send: (data: number[] | Uint8Array) => void;
};

type MidiAccess = {
  inputs: Map<string, MidiInput>;
  outputs: Map<string, MidiOutput>;
  onstatechange: ((event: Event) => void) | null;
};

type ParticipantStats = {
  rttMs?: number;
  jitterMs?: number;
  packetLossPct?: number;
  path?: "p2p" | "relay" | "unknown";
};

type SessionResponse = {
  sessionId: string;
};

type LoginResponse = {
  user: AuthUser;
  token: string;
};

type SessionsResponse = {
  sessions: SessionListItem[];
};

type SessionCreateResponse = {
  session: SessionListItem;
};

type JoinResponse = {
  token: string;
  livekitUrl: string;
  room: string;
  session: SessionListItem;
  role: Role;
};

type LinkProxyState = {
  tempo: number;
  beat: number;
  phase: number;
  quantum: number;
  numPeers: number;
  transport: "playing" | "paused" | "stopped";
  mode: SyncMode;
  role: Role;
};

type LinkProxyStatus = "idle" | "connecting" | "connected" | "error";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const linkProxyUrl = process.env.NEXT_PUBLIC_LINK_PROXY_URL ?? "ws://localhost:3210";
const midiInputStorageKey = "remote-dj:midi-input";
const midiOutputStorageKey = "remote-dj:midi-output";
const authTokenStorageKey = "remote-dj:auth-token";
const programOutUrl = process.env.NEXT_PUBLIC_PROGRAM_OUT_URL ?? "";
const syncUrl = (() => {
  if (process.env.NEXT_PUBLIC_SYNC_URL) {
    return process.env.NEXT_PUBLIC_SYNC_URL;
  }
  try {
    const base = new URL(apiBaseUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/sync";
    return base.toString();
  } catch (error) {
    return apiBaseUrl.replace(/^http/, "ws") + "/sync";
  }
})();

const latencyClass = (rttMs?: number) => {
  if (!rttMs) {
    return "latency-dot";
  }
  if (rttMs < 90) {
    return "latency-dot";
  }
  if (rttMs < 180) {
    return "latency-dot latency-warn";
  }
  return "latency-dot latency-bad";
};

const formatMetric = (value?: number, unit = "ms") => {
  if (value === undefined || Number.isNaN(value)) {
    return "--";
  }
  return `${Math.round(value)}${unit}`;
};

const formatPercent = (value?: number) => {
  if (value === undefined || Number.isNaN(value)) {
    return "--";
  }
  return `${value.toFixed(1)}%`;
};

const getLatencyBadge = (
  rttMs?: number,
  jitterMs?: number,
  packetLossPct?: number,
  controlPlaneRttMs?: number
): { label: string; className: string } => {
  if (rttMs === undefined && jitterMs === undefined && packetLossPct === undefined && controlPlaneRttMs === undefined) {
    return { label: "latency unknown", className: "latency-badge unknown" };
  }
  const loss = packetLossPct ?? 0;
  const jitter = jitterMs ?? 0;
  const candidateRtt = rttMs ?? 0;
  const controlRtt = controlPlaneRttMs ?? 0;
  const rtt = Math.max(candidateRtt, controlRtt);
  if (rtt < 120 && jitter < 30 && loss < 1) {
    return { label: "latency ok", className: "latency-badge good" };
  }
  if (rtt < 220 && jitter < 50 && loss < 3) {
    return { label: "latency warn", className: "latency-badge warn" };
  }
  return { label: "latency high", className: "latency-badge bad" };
};

const formatDuration = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const formatTimestamp = (value?: string) => {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString();
};

const formatSyncMode = (mode?: SyncMode) => {
  switch (mode) {
    case "LINK_LAN":
      return "Link (LAN)";
    case "LINK_WAN":
      return "Link (WAN)";
    case "MIDI":
      return "MIDI";
    default:
      return "Unknown";
  }
};

const fetchJson = async <T,>(
  url: string,
  options?: RequestInit,
  authToken?: string
): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options?.headers ?? {})
    },
    ...options
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || response.statusText);
  }

  return (await response.json()) as T;
};

const parseStats = (rawStats: unknown) => {
  const statsList: Array<Record<string, unknown>> = [];

  if (Array.isArray(rawStats)) {
    statsList.push(...(rawStats as Array<Record<string, unknown>>));
  } else if (rawStats instanceof Map) {
    for (const value of rawStats.values()) {
      if (Array.isArray(value)) {
        statsList.push(...(value as Array<Record<string, unknown>>));
      }
    }
  } else if (rawStats && typeof rawStats === "object") {
    statsList.push(rawStats as Record<string, unknown>);
  }

  const byIdentity = new Map<string, ParticipantStats>();

  const toNumber = (value: unknown) => {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  };

  const toMs = (value: number | undefined) => {
    if (value === undefined) {
      return undefined;
    }
    return value < 10 ? value * 1000 : value;
  };

  const toPath = (value: unknown) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.toLowerCase();
    if (normalized.includes("relay")) {
      return "relay" as const;
    }
    if (normalized.includes("host") || normalized.includes("srflx")) {
      return "p2p" as const;
    }
    return undefined;
  };

  for (const stats of statsList) {
    const mediaType =
      (stats.kind as string | undefined) ||
      (stats.mediaType as string | undefined) ||
      (stats.trackKind as string | undefined);
    if (mediaType && !mediaType.toLowerCase().includes("audio")) {
      continue;
    }

    const identity =
      (stats.participantIdentity as string | undefined) ||
      (stats.participantName as string | undefined) ||
      (stats.participantId as string | undefined) ||
      (stats.participant_sid as string | undefined);

    if (!identity) {
      continue;
    }

    const current = byIdentity.get(identity) ?? {};
    const rtt = toMs(toNumber(stats.currentRoundTripTime ?? stats.rtt));
    const jitter = toMs(toNumber(stats.jitter));
    const packetsLost = toNumber(stats.packetsLost ?? stats.packets_lost);
    const packetsReceived = toNumber(stats.packetsReceived ?? stats.packets_received);
    const candidateType = stats.candidateType ?? stats.localCandidateType ?? stats.remoteCandidateType;
    const relayProtocol = stats.relayProtocol;
    const path = relayProtocol ? "relay" : toPath(candidateType) ?? current.path;
    let packetLossPct = current.packetLossPct;

    if (packetsLost !== undefined && packetsReceived !== undefined) {
      const total = packetsLost + packetsReceived;
      if (total > 0) {
        packetLossPct = (packetsLost / total) * 100;
      }
    }

    byIdentity.set(identity, {
      rttMs: rtt ?? current.rttMs,
      jitterMs: jitter ?? current.jitterMs,
      packetLossPct,
      path
    });
  }

  return byIdentity;
};

const formatMidiData = (data: Uint8Array) => {
  return Array.from(data)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join(" ");
};

const pickFirstPublication = (publications: Iterable<TrackPublication>) => {
  for (const publication of publications) {
    if (publication.track) {
      return publication;
    }
  }
  return undefined;
};

const parseParticipantMeta = (metadata?: string | null): ParticipantMeta | null => {
  if (!metadata) {
    return null;
  }
  try {
    return JSON.parse(metadata) as ParticipantMeta;
  } catch (error) {
    return null;
  }
};

const getInitials = (value: string) => {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "DJ";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
};

const getDeviceSnapshot = async (): Promise<DeviceSnapshot> => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return {};
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cam = devices.find((device) => device.kind === "videoinput");
  const mic = devices.find((device) => device.kind === "audioinput");
  const output = devices.find((device) => device.kind === "audiooutput");

  return {
    cam: cam?.label,
    mic: mic?.label,
    output: output?.label
  };
};

type ParticipantTileProps = {
  participant: Participant;
  isLocal: boolean;
  connectionState: string;
  stats?: ParticipantStats;
  deviceInfo?: DeviceSnapshot;
  midiLabels?: MidiLabels;
  syncMode?: SyncMode;
  midiChannel?: number;
  monitorMode: MonitorMode;
  soloIdentity: string | null;
  onSoloToggle: (identity: string) => void;
  controlPlaneRttMs?: number;
  audioLevel?: number;
  isRecording?: boolean;
  version: number;
};

const ParticipantTile = ({
  participant,
  isLocal,
  connectionState,
  stats,
  deviceInfo,
  midiLabels,
  syncMode,
  midiChannel,
  monitorMode,
  soloIdentity,
  onSoloToggle,
  controlPlaneRttMs,
  audioLevel,
  isRecording,
  version
}: ParticipantTileProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const videoPublication = useMemo(() => {
    const publications = (participant as any).videoTrackPublications?.values?.() ?? [];
    return pickFirstPublication(publications);
  }, [participant, version]);

  const audioPublication = useMemo(() => {
    const publications = (participant as any).audioTrackPublications?.values?.() ?? [];
    return pickFirstPublication(publications);
  }, [participant, version]);

  const videoTrack = videoPublication?.track;
  const audioTrack = audioPublication?.track;

  useEffect(() => {
    if (!videoRef.current || !videoTrack) {
      return;
    }
    videoTrack.attach(videoRef.current);
    return () => {
      videoTrack.detach(videoRef.current!);
    };
  }, [videoTrack]);

  useEffect(() => {
    if (!audioRef.current || !audioTrack) {
      return;
    }
    audioTrack.attach(audioRef.current);
    return () => {
      audioTrack.detach(audioRef.current!);
    };
  }, [audioTrack]);

  const connectionQuality = participant.connectionQuality ?? ConnectionQuality.Unknown;
  const identity = participant.identity || "guest";
  const displayName = participant.name || participant.identity || "Guest";
  const metadata = parseParticipantMeta(participant.metadata);
  const roleBadge = metadata?.role || (isLocal ? "local" : "peer");
  const showAvatar = !videoTrack || videoPublication?.isMuted;
  const audioLevelValue = Math.min(Math.max(audioLevel ?? 0, 0), 1);
  const latencyBadge = getLatencyBadge(
    stats?.rttMs,
    stats?.jitterMs,
    stats?.packetLossPct,
    controlPlaneRttMs
  );
  const pathLabel =
    stats?.path === "relay" ? "Relay" : stats?.path === "p2p" ? "P2P" : "Unknown";
  const syncLabel = formatSyncMode(metadata?.syncMode ?? (isLocal ? syncMode : undefined));
  const isSolo = monitorMode === "solo" && soloIdentity === identity;
  const shouldMonitor = !isLocal && (monitorMode === "room" || isSolo);

  useEffect(() => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.muted = !shouldMonitor || isLocal;
    audioRef.current.volume = shouldMonitor ? 1 : 0;
  }, [shouldMonitor, isLocal]);

  return (
    <div className="tile">
      <div className="tile-media">
        {showAvatar ? (
          <div className="avatar">
            <span>{getInitials(displayName)}</span>
          </div>
        ) : (
          <video ref={videoRef} muted={isLocal} playsInline />
        )}
        <audio ref={audioRef} muted />
      </div>
      <div>
        <div className="tile-header">
          <div className="tile-name">{displayName}</div>
          <div className="tile-header-right">
            {midiChannel ? <span className="channel-pill">CH {midiChannel}</span> : null}
            <button
              type="button"
              className={isSolo ? "mini-toggle active" : "mini-toggle"}
              onClick={() => onSoloToggle(identity)}
              disabled={isLocal}
            >
              {isSolo ? "Soloing" : "Solo"}
            </button>
            {isRecording ? <span className="rec-pill">REC</span> : null}
            <div className="status-pill">{connectionState}</div>
          </div>
        </div>
        <div className="tile-sub">
          <span className="role-badge">{roleBadge}</span>
          <span className={latencyBadge.className}>{latencyBadge.label}</span>
          {isLocal ? <span className="status-pill">You</span> : null}
          <span className="status-pill">Sync {syncLabel}</span>
        </div>
        <div className="tile-body">
          <div className="audio-meter">
            <div className="audio-meter-fill" style={{ width: `${audioLevelValue * 100}%` }} />
          </div>
          <div className="metric-grid">
            <div className="metric">
              <span>Connection</span>
              <strong>{ConnectionQuality[connectionQuality]}</strong>
            </div>
            <div className="metric">
              <span>RTT</span>
              <div className="metric-inline">
                <div className={latencyClass(stats?.rttMs)} />
                <strong>{formatMetric(stats?.rttMs)}</strong>
              </div>
            </div>
            <div className="metric">
              <span>Jitter</span>
              <strong>{formatMetric(stats?.jitterMs)}</strong>
            </div>
            <div className="metric">
              <span>Packet loss</span>
              <strong>{formatPercent(stats?.packetLossPct)}</strong>
            </div>
            <div className="metric">
              <span>Path</span>
              <strong>{pathLabel}</strong>
            </div>
          </div>
          <div className="device-grid">
            <div>
              <span>Audio In</span>
              <strong>{deviceInfo?.mic || metadata?.devices?.mic || (isLocal ? "--" : "Remote")}</strong>
            </div>
            <div>
              <span>Audio Out</span>
              <strong>
                {deviceInfo?.output || metadata?.devices?.output || (isLocal ? "--" : "Remote")}
              </strong>
            </div>
            <div>
              <span>MIDI In</span>
              <strong>
                {midiLabels?.input || metadata?.devices?.midiIn || (isLocal ? "--" : "Remote")}
              </strong>
            </div>
            <div>
              <span>MIDI Out</span>
              <strong>
                {midiLabels?.output || metadata?.devices?.midiOut || (isLocal ? "--" : "Remote")}
              </strong>
            </div>
            <div>
              <span>Sync</span>
              <strong>{syncLabel}</strong>
            </div>
            <div>
              <span>Channel</span>
              <strong>{midiChannel ? `CH ${midiChannel}` : "CH --"}</strong>
            </div>
            <div>
              <span>Cam</span>
              <strong>{deviceInfo?.cam || metadata?.devices?.cam || (isLocal ? "--" : "Remote")}</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const HomePage = () => {
  const [roomName, setRoomName] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionName, setActiveSessionName] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("peer");
  const [syncMode, setSyncMode] = useState<SyncMode>("LINK_LAN");
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [deviceInfo, setDeviceInfo] = useState<DeviceSnapshot>({});
  const [participantStats, setParticipantStats] = useState<Map<string, ParticipantStats>>(new Map());
  const [trackVersion, setTrackVersion] = useState(0);
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string>("");
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [loginName, setLoginName] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionName, setSessionName] = useState("");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);

  const [midiSupported, setMidiSupported] = useState<boolean | null>(null);
  const [midiAccess, setMidiAccess] = useState<MidiAccess | null>(null);
  const [midiInputs, setMidiInputs] = useState<MidiInput[]>([]);
  const [midiOutputs, setMidiOutputs] = useState<MidiOutput[]>([]);
  const [selectedMidiInputId, setSelectedMidiInputId] = useState<string>("");
  const [selectedMidiOutputId, setSelectedMidiOutputId] = useState<string>("");
  const [lastMidiMessage, setLastMidiMessage] = useState<string | null>(null);
  const [midiStatus, setMidiStatus] = useState<"idle" | "enabling" | "enabled" | "unsupported">("idle");
  const [midiError, setMidiError] = useState<string | null>(null);
  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map());
  const [sendMidiClock, setSendMidiClock] = useState(false);
  const [monitorMode, setMonitorMode] = useState<MonitorMode>("off");
  const [soloIdentity, setSoloIdentity] = useState<string | null>(null);

  const [masterKey, setMasterKey] = useState(process.env.NEXT_PUBLIC_MASTER_KEY ?? "");
  const [recordingSessionId, setRecordingSessionId] = useState<string | null>(null);
  const [recordingStatus, setRecordingStatus] = useState<"idle" | "recording" | "stopped">("idle");
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [playbackSessionId, setPlaybackSessionId] = useState<string | null>(null);
  const [programStatus, setProgramStatus] = useState<"idle" | "running">("idle");
  const [programError, setProgramError] = useState<string | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [syncTempo, setSyncTempo] = useState(120);
  const [syncTransport, setSyncTransport] = useState<"stopped" | "playing" | "paused">("stopped");
  const [syncStatus, setSyncStatus] = useState<"idle" | "connecting" | "connected" | "error">(
    "idle"
  );
  const [syncRttMs, setSyncRttMs] = useState<number | undefined>(undefined);
  const [syncJitterMs, setSyncJitterMs] = useState<number | undefined>(undefined);
  const [syncQuantum, setSyncQuantum] = useState(4);
  const [metronomeOn, setMetronomeOn] = useState(false);
  const [linkProxyStatus, setLinkProxyStatus] = useState<LinkProxyStatus>("idle");
  const [linkProxyState, setLinkProxyState] = useState<LinkProxyState | null>(null);
  const [linkProxyError, setLinkProxyError] = useState<string | null>(null);
  const [apiRttMs, setApiRttMs] = useState<number | undefined>(undefined);
  const [apiPingError, setApiPingError] = useState(false);
  const syncSocketRef = useRef<WebSocket | null>(null);
  const syncIntervalRef = useRef<number | null>(null);
  const syncRttHistoryRef = useRef<number[]>([]);
  const syncPingIntervalRef = useRef<number | null>(null);
  const sessionGridRef = useRef<HTMLDivElement | null>(null);
  const metronomeContextRef = useRef<AudioContext | null>(null);
  const metronomeIntervalRef = useRef<number | null>(null);
  const metronomeBeatRef = useRef(0);
  const linkProxyRef = useRef<WebSocket | null>(null);
  const syncModeRef = useRef<SyncMode>(syncMode);
  const linkProxyStatusRef = useRef<LinkProxyStatus>(linkProxyStatus);
  const isConnected = Boolean(room);

  const updateParticipants = useCallback((currentRoom: Room) => {
    const list = [currentRoom.localParticipant, ...Array.from(currentRoom.remoteParticipants.values())];
    setParticipants(list);
  }, []);

  const refreshSessions = useCallback(
    async (tokenOverride?: string) => {
      const token = tokenOverride ?? authToken;
      if (!token) {
        return;
      }
      try {
        const response = await fetchJson<SessionsResponse>(
          `${apiBaseUrl}/sessions`,
          undefined,
          token
        );
        setSessions(response.sessions);
      } catch (error) {
        // ignore
      }
    },
    [authToken]
  );

  const masterIdentity = useMemo(() => {
    for (const participant of participants) {
      const metadata = parseParticipantMeta(participant.metadata);
      if (metadata?.role === "master") {
        return participant.name ?? participant.identity ?? "master";
      }
    }
    if (role === "master") {
      return currentUser?.displayName ?? "master";
    }
    return "unknown";
  }, [participants, role, currentUser]);

  const channelAssignments = useMemo(() => {
    const entries = participants
      .map((participant) => participant.identity)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => a.localeCompare(b));
    const assignment = new Map<string, number>();
    entries.forEach((value, index) => {
      assignment.set(value, 2 + (index % 4));
    });
    return assignment;
  }, [participants]);

  const refreshMidiDevices = useCallback(
    (access: MidiAccess) => {
      const inputs = Array.from(access.inputs.values());
      const outputs = Array.from(access.outputs.values());
      setMidiInputs(inputs);
      setMidiOutputs(outputs);

      if (!inputs.length) {
        setSelectedMidiInputId("");
      } else if (!inputs.find((input) => input.id === selectedMidiInputId)) {
        setSelectedMidiInputId(inputs[0].id);
      }

      if (!outputs.length) {
        setSelectedMidiOutputId("");
      } else if (!outputs.find((output) => output.id === selectedMidiOutputId)) {
        setSelectedMidiOutputId(outputs[0].id);
      }
    },
    [selectedMidiInputId, selectedMidiOutputId]
  );

  const handleLogin = async () => {
    setLoginError(null);
    if (!loginName.trim()) {
      setLoginError("Enter a display name to continue.");
      return;
    }
    try {
      const response = await fetchJson<LoginResponse>(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ displayName: loginName })
      });
      setAuthToken(response.token);
      setCurrentUser(response.user);
      window.localStorage.setItem(authTokenStorageKey, response.token);
      refreshSessions(response.token);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Failed to sign in.");
    }
  };

  const handleLogout = () => {
    if (room) {
      room.disconnect();
    }
    setAuthToken("");
    setCurrentUser(null);
    setSessions([]);
    window.localStorage.removeItem(authTokenStorageKey);
    setRoom(null);
    setParticipants([]);
    setConnectionState("disconnected");
    setActiveSessionId(null);
    setActiveSessionName(null);
    setRoomName("");
    setMetronomeOn(false);
  };

  const sendLinkProxy = useCallback((payload: unknown) => {
    const socket = linkProxyRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }, []);

  const handleCreateSession = async () => {
    if (!authToken) {
      return;
    }
    setSessionError(null);
    if (!sessionName.trim()) {
      setSessionError("Session name is required.");
      return;
    }
    try {
      const response = await fetchJson<SessionCreateResponse>(
        `${apiBaseUrl}/sessions`,
        {
          method: "POST",
          body: JSON.stringify({ name: sessionName })
        },
        authToken
      );
      setSessionName("");
      setSessions((current) => [response.session, ...current]);
      refreshSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Failed to create session.");
    }
  };

  const handleResume = () => {
    sessionGridRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const joinSession = async (session: SessionListItem) => {
    if (!authToken) {
      return;
    }
    setJoinError(null);
    setIsJoining(true);

    try {
      if (room) {
        await room.disconnect();
        setRoom(null);
        setParticipants([]);
      }

      const response = await fetchJson<JoinResponse>(
        `${apiBaseUrl}/sessions/${session.id}/join`,
        {
          method: "POST",
          body: JSON.stringify({ role })
        },
        authToken
      );

      const newRoom = new Room({
        adaptiveStream: true,
        dynacast: true
      });

      newRoom.on(RoomEvent.Disconnected, () => {
        setRoom(null);
        setParticipants([]);
        setConnectionState("disconnected");
        setActiveSessionId(null);
        setActiveSessionName(null);
        setRoomName("");
        setMonitorMode("off");
        setSoloIdentity(null);
        setMetronomeOn(false);
      });

      await newRoom.connect(response.livekitUrl, response.token);
      await newRoom.localParticipant.setMicrophoneEnabled(micEnabled);
      await newRoom.localParticipant.setCameraEnabled(camEnabled);

      setRoomName(response.room);
      setActiveSessionId(response.session.id);
      setActiveSessionName(response.session.name);
      setRoom(newRoom);
      updateParticipants(newRoom);
      refreshSessions();

      const info = await getDeviceSnapshot();
      setDeviceInfo(info);
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "Failed to join session");
    } finally {
      setIsJoining(false);
    }
  };

  const toggleRoomMix = () => {
    setMonitorMode((current) => (current === "room" ? "off" : "room"));
    setSoloIdentity(null);
  };

  const toggleSolo = (targetIdentity: string) => {
    setSoloIdentity((currentSolo) => {
      if (monitorMode === "solo" && currentSolo === targetIdentity) {
        setMonitorMode("off");
        return null;
      }
      setMonitorMode("solo");
      return targetIdentity;
    });
  };

  const stopMetronome = useCallback(() => {
    if (metronomeIntervalRef.current) {
      window.clearInterval(metronomeIntervalRef.current);
      metronomeIntervalRef.current = null;
    }
    metronomeBeatRef.current = 0;
  }, []);

  const startMetronome = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const AudioContextCtor =
      (window as typeof window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextCtor) {
      return;
    }

    if (!metronomeContextRef.current) {
      metronomeContextRef.current = new AudioContextCtor();
    }
    const ctx = metronomeContextRef.current;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => undefined);
    }

    const intervalMs = Math.max(30, Math.round(60000 / syncTempo));
    const quantum = Math.max(1, syncQuantum);

    const tick = () => {
      const beat = metronomeBeatRef.current;
      const isDownbeat = beat % quantum === 0;
      metronomeBeatRef.current = (beat + 1) % quantum;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = isDownbeat ? 1200 : 800;
      gain.gain.value = 0.001;
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.1);
    };

    tick();
    metronomeIntervalRef.current = window.setInterval(tick, intervalMs);
  }, [syncTempo, syncQuantum]);

  const enableMidi = async () => {
    setMidiError(null);
    if (typeof navigator === "undefined") {
      return;
    }
    const hasSupport = "requestMIDIAccess" in navigator;
    setMidiSupported(hasSupport);
    if (!hasSupport) {
      setMidiStatus("unsupported");
      return;
    }
    try {
      setMidiStatus("enabling");
      const access = await (navigator as Navigator & { requestMIDIAccess: () => Promise<MidiAccess> }).requestMIDIAccess();
      setMidiAccess(access);
      setMidiStatus("enabled");
      refreshMidiDevices(access);
    } catch (error) {
      setMidiError("MIDI access denied or unavailable.");
      setMidiStatus("idle");
    }
  };

  const sendTestNote = () => {
    const output = midiOutputs.find((device) => device.id === selectedMidiOutputId);
    if (!output) {
      setMidiError("Select a MIDI output to send.");
      return;
    }
    setMidiError(null);
    try {
      const note = 60;
      const velocity = 100;
      output.send([0x90, note, velocity]);
      window.setTimeout(() => output.send([0x80, note, 0]), 220);
    } catch (error) {
      setMidiError("Failed to send MIDI note.");
    }
  };

  const localMidiLabels = useMemo<MidiLabels>(() => {
    const input = midiInputs.find((device) => device.id === selectedMidiInputId);
    const output = midiOutputs.find((device) => device.id === selectedMidiOutputId);
    return {
      input: input?.name,
      output: output?.name
    };
  }, [midiInputs, midiOutputs, selectedMidiInputId, selectedMidiOutputId]);

  useEffect(() => {
    if (!room) {
      return;
    }
    const payload: ParticipantMeta = {
      role,
      syncMode,
      devices: {
        cam: deviceInfo.cam,
        mic: deviceInfo.mic,
        output: deviceInfo.output,
        midiIn: localMidiLabels.input,
        midiOut: localMidiLabels.output
      }
    };
    room.localParticipant
      .setMetadata(JSON.stringify(payload))
      .catch(() => undefined);
  }, [room, role, syncMode, deviceInfo, localMidiLabels]);

  useEffect(() => {
    if (typeof navigator === "undefined") {
      return;
    }
    const supported = "requestMIDIAccess" in navigator;
    setMidiSupported(supported);
    if (!supported) {
      setMidiStatus("unsupported");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const storedInput = window.localStorage.getItem(midiInputStorageKey);
    const storedOutput = window.localStorage.getItem(midiOutputStorageKey);
    if (storedInput) {
      setSelectedMidiInputId(storedInput);
    }
    if (storedOutput) {
      setSelectedMidiOutputId(storedOutput);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const storedToken = window.localStorage.getItem(authTokenStorageKey);
    if (storedToken) {
      setAuthToken(storedToken);
    }
  }, []);

  useEffect(() => {
    if (!authToken) {
      setCurrentUser(null);
      return;
    }
    let active = true;
    fetchJson<{ user: AuthUser }>(`${apiBaseUrl}/me`, undefined, authToken)
      .then((response) => {
        if (active) {
          setCurrentUser(response.user);
        }
      })
      .catch(() => {
        if (active) {
          setAuthToken("");
          setCurrentUser(null);
          window.localStorage.removeItem(authTokenStorageKey);
        }
      });
    return () => {
      active = false;
    };
  }, [authToken]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }
    refreshSessions();
  }, [currentUser, refreshSessions]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (selectedMidiInputId) {
      window.localStorage.setItem(midiInputStorageKey, selectedMidiInputId);
    } else {
      window.localStorage.removeItem(midiInputStorageKey);
    }
  }, [selectedMidiInputId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (selectedMidiOutputId) {
      window.localStorage.setItem(midiOutputStorageKey, selectedMidiOutputId);
    } else {
      window.localStorage.removeItem(midiOutputStorageKey);
    }
  }, [selectedMidiOutputId]);

  useEffect(() => {
    if (!midiAccess) {
      return;
    }
    const handleStateChange = () => refreshMidiDevices(midiAccess);
    midiAccess.onstatechange = handleStateChange;
    refreshMidiDevices(midiAccess);
    return () => {
      midiAccess.onstatechange = null;
    };
  }, [midiAccess, refreshMidiDevices]);

  useEffect(() => {
    const input = midiInputs.find((device) => device.id === selectedMidiInputId);
    if (!input) {
      setLastMidiMessage(null);
      return;
    }
    setLastMidiMessage(null);
    const handleMessage = (event: MidiMessageEvent) => {
      setLastMidiMessage(formatMidiData(event.data));
    };
    input.onmidimessage = handleMessage;
    return () => {
      input.onmidimessage = null;
    };
  }, [midiInputs, selectedMidiInputId]);

  useEffect(() => {
    if (!sendMidiClock) {
      return;
    }
    const output = midiOutputs.find((device) => device.id === selectedMidiOutputId);
    if (!output) {
      setMidiError("Select a MIDI output to send clock.");
      setSendMidiClock(false);
      return;
    }
    setMidiError(null);
    const bpm = 120;
    const intervalMs = 60000 / (bpm * 24);
    const timer = window.setInterval(() => {
      try {
        output.send([0xf8]);
      } catch (error) {
        setMidiError("Failed to send MIDI clock.");
        setSendMidiClock(false);
      }
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [sendMidiClock, midiOutputs, selectedMidiOutputId]);

  useEffect(() => {
    if (midiStatus !== "enabled" && sendMidiClock) {
      setSendMidiClock(false);
    }
  }, [midiStatus, sendMidiClock]);

  useEffect(() => {
    if (recordingStatus !== "recording" || recordingStartedAt === null) {
      setRecordingElapsed(0);
      return;
    }
    const tick = () => {
      const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
      setRecordingElapsed(elapsed);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [recordingStatus, recordingStartedAt]);

  useEffect(() => {
    syncModeRef.current = syncMode;
  }, [syncMode]);

  useEffect(() => {
    linkProxyStatusRef.current = linkProxyStatus;
  }, [linkProxyStatus]);

  useEffect(() => {
    if (!room) {
      if (syncSocketRef.current) {
        syncSocketRef.current.close();
        syncSocketRef.current = null;
      }
      setSyncStatus("idle");
      setSyncRttMs(undefined);
      setSyncJitterMs(undefined);
      return;
    }

    const socket = new WebSocket(syncUrl);
    syncSocketRef.current = socket;
    setSyncStatus("connecting");

    const sendMessage = (payload: unknown) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    socket.onopen = () => {
      setSyncStatus("connected");
      sendMessage({
        type: "join",
        room: roomName,
        role,
        masterKey: role === "master" ? masterKey : undefined
      });
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as {
          type: string;
          tempo?: number;
          transport?: "stopped" | "playing" | "paused";
          mode?: SyncMode;
          quantum?: number;
          sentAt?: number;
        };
        if (message.type === "state") {
          const allowUpdate =
            syncModeRef.current === "MIDI" || linkProxyStatusRef.current !== "connected";
          if (allowUpdate && typeof message.tempo === "number") {
            setSyncTempo(message.tempo);
          }
          if (allowUpdate && message.transport) {
            setSyncTransport(message.transport);
          }
          if (allowUpdate && message.mode && ["LINK_LAN", "LINK_WAN", "MIDI"].includes(message.mode)) {
            setSyncMode(message.mode as SyncMode);
          }
          if (allowUpdate && typeof message.quantum === "number" && Number.isFinite(message.quantum)) {
            setSyncQuantum(Math.max(1, Math.round(message.quantum)));
          }
        } else if (message.type === "pong" && typeof message.sentAt === "number") {
          const rtt = performance.now() - message.sentAt;
          if (Number.isFinite(rtt)) {
            const history = syncRttHistoryRef.current;
            history.push(rtt);
            if (history.length > 6) {
              history.shift();
            }
            setSyncRttMs(Math.round(rtt));
            if (history.length > 1) {
              const diffs = history.slice(1).map((value, index) => Math.abs(value - history[index]));
              const avg = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
              setSyncJitterMs(Math.round(avg));
            }
          }
        }
      } catch (error) {
        // ignore
      }
    };

    socket.onerror = () => {
      setSyncStatus("error");
    };

    socket.onclose = () => {
      setSyncStatus("idle");
      setSyncRttMs(undefined);
      setSyncJitterMs(undefined);
    };

    return () => {
      socket.close();
    };
  }, [room, roomName, role, masterKey]);

  useEffect(() => {
    if (!isConnected || syncMode === "MIDI") {
      if (linkProxyRef.current) {
        linkProxyRef.current.close();
        linkProxyRef.current = null;
      }
      setLinkProxyStatus("idle");
      setLinkProxyState(null);
      return;
    }

    const socket = new WebSocket(linkProxyUrl);
    linkProxyRef.current = socket;
    setLinkProxyStatus("connecting");
    setLinkProxyError(null);

    socket.onopen = () => {
      setLinkProxyStatus("connected");
      socket.send(
        JSON.stringify({
          type: "configure",
          room: roomName,
          role,
          mode: syncMode,
          apiUrl: syncUrl,
          masterKey: role === "master" ? masterKey : undefined
        })
      );
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as {
          type: string;
          tempo?: number;
          beat?: number;
          phase?: number;
          quantum?: number;
          numPeers?: number;
          transport?: "playing" | "paused" | "stopped";
          mode?: SyncMode;
          role?: Role;
          error?: string;
        };
        if (message.type === "state") {
          if (typeof message.tempo !== "number" || typeof message.quantum !== "number") {
            return;
          }
          setLinkProxyState({
            tempo: message.tempo,
            beat: message.beat ?? 0,
            phase: message.phase ?? 0,
            quantum: message.quantum,
            numPeers: message.numPeers ?? 1,
            transport: message.transport ?? "playing",
            mode: message.mode ?? syncMode,
            role: message.role ?? role
          });
        } else if (message.type === "error" && message.error) {
          setLinkProxyError(message.error);
        }
      } catch (error) {
        // ignore
      }
    };

    socket.onerror = () => {
      setLinkProxyStatus("error");
    };

    socket.onclose = () => {
      setLinkProxyStatus("idle");
    };

    return () => {
      socket.close();
    };
  }, [isConnected, syncMode, roomName, role, masterKey, syncUrl, linkProxyUrl]);

  useEffect(() => {
    if (!linkProxyState || syncMode === "MIDI") {
      return;
    }
    setSyncTempo(Math.round(linkProxyState.tempo));
    setSyncQuantum(Math.max(1, Math.round(linkProxyState.quantum)));
    setSyncTransport(linkProxyState.transport);
  }, [linkProxyState, syncMode]);

  useEffect(() => {
    if (linkProxyStatus !== "connected" || syncMode === "MIDI") {
      return;
    }
    sendLinkProxy({
      type: "configure",
      room: roomName,
      role,
      mode: syncMode,
      apiUrl: syncUrl,
      masterKey: role === "master" ? masterKey : undefined
    });
  }, [linkProxyStatus, syncMode, roomName, role, masterKey, syncUrl, sendLinkProxy]);

  useEffect(() => {
    if (role !== "master" || syncStatus !== "connected" || syncMode !== "MIDI") {
      if (syncIntervalRef.current) {
        window.clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
      return;
    }
    const socket = syncSocketRef.current;
    if (!socket) {
      return;
    }
    const sendState = () => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(
        JSON.stringify({
          type: "state",
          tempo: syncTempo,
          transport: syncTransport,
          mode: syncMode,
          quantum: syncQuantum
        })
      );
    };
    sendState();
    syncIntervalRef.current = window.setInterval(sendState, 250);
    return () => {
      if (syncIntervalRef.current) {
        window.clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };
  }, [role, syncStatus, syncMode, syncTempo, syncTransport, syncQuantum]);

  useEffect(() => {
    if (syncStatus !== "connected") {
      if (syncPingIntervalRef.current) {
        window.clearInterval(syncPingIntervalRef.current);
        syncPingIntervalRef.current = null;
      }
      return;
    }
    const socket = syncSocketRef.current;
    if (!socket) {
      return;
    }
    const sendPing = () => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(
        JSON.stringify({
          type: "ping",
          sentAt: performance.now()
        })
      );
    };
    sendPing();
    syncPingIntervalRef.current = window.setInterval(sendPing, 2000);
    return () => {
      if (syncPingIntervalRef.current) {
        window.clearInterval(syncPingIntervalRef.current);
        syncPingIntervalRef.current = null;
      }
    };
  }, [syncStatus]);

  useEffect(() => {
    if (!metronomeOn) {
      stopMetronome();
      return;
    }
    stopMetronome();
    startMetronome();
    return () => {
      stopMetronome();
    };
  }, [metronomeOn, syncTempo, syncQuantum, startMetronome, stopMetronome]);

  useEffect(() => {
    if (!isConnected) {
      setApiRttMs(undefined);
      setApiPingError(false);
      return;
    }

    let active = true;

    const ping = async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 3000);
      const startedAt = performance.now();
      try {
        const response = await fetch(`${apiBaseUrl}/ping`, {
          signal: controller.signal,
          cache: "no-store"
        });
        window.clearTimeout(timeout);
        if (!response.ok) {
          throw new Error("Ping failed");
        }
        await response.json();
        const elapsed = performance.now() - startedAt;
        if (active && Number.isFinite(elapsed)) {
          setApiRttMs(Math.round(elapsed));
          setApiPingError(false);
        }
      } catch (error) {
        window.clearTimeout(timeout);
        if (active) {
          setApiRttMs(undefined);
          setApiPingError(true);
        }
      }
    };

    ping();
    const interval = window.setInterval(ping, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [isConnected]);

  useEffect(() => {
    if (!room) {
      return;
    }

    updateParticipants(room);
    setConnectionState(String(room.state));

    const handleRoomUpdate = () => updateParticipants(room);
    const handleTrackChange = () => setTrackVersion((v) => v + 1);
    const handleConnectionChange = (state: string) => setConnectionState(String(state));

    room.on(RoomEvent.ParticipantConnected, handleRoomUpdate);
    room.on(RoomEvent.ParticipantDisconnected, handleRoomUpdate);
    room.on(RoomEvent.TrackSubscribed, handleTrackChange);
    room.on(RoomEvent.TrackUnsubscribed, handleTrackChange);
    room.on(RoomEvent.LocalTrackPublished, handleTrackChange);
    room.on(RoomEvent.LocalTrackUnpublished, handleTrackChange);
    room.on(RoomEvent.ConnectionStateChanged, handleConnectionChange);

    const statsInterval = window.setInterval(async () => {
      const getStats = (room as any).getStats?.bind(room);
      if (!getStats) {
        return;
      }
      try {
        const stats = await getStats();
        const parsed = parseStats(stats);
        if (parsed.size > 0) {
          setParticipantStats(new Map(parsed));
        }
      } catch (error) {
        // ignore
      }
    }, 2000);

    const audioInterval = window.setInterval(() => {
      const levels = new Map<string, number>();
      const all = [room.localParticipant, ...room.remoteParticipants.values()];
      for (const participant of all) {
        if (participant.identity) {
          levels.set(participant.identity, participant.audioLevel ?? 0);
        }
      }
      setAudioLevels(levels);
    }, 200);

    return () => {
      room.off(RoomEvent.ParticipantConnected, handleRoomUpdate);
      room.off(RoomEvent.ParticipantDisconnected, handleRoomUpdate);
      room.off(RoomEvent.TrackSubscribed, handleTrackChange);
      room.off(RoomEvent.TrackUnsubscribed, handleTrackChange);
      room.off(RoomEvent.LocalTrackPublished, handleTrackChange);
      room.off(RoomEvent.LocalTrackUnpublished, handleTrackChange);
      room.off(RoomEvent.ConnectionStateChanged, handleConnectionChange);
      window.clearInterval(statsInterval);
      window.clearInterval(audioInterval);
    };
  }, [room, updateParticipants]);

  const leaveRoom = async () => {
    if (room) {
      await room.disconnect();
    }
    setRoom(null);
    setParticipants([]);
    setConnectionState("disconnected");
    setActiveSessionId(null);
    setActiveSessionName(null);
    setRoomName("");
    setMonitorMode("off");
    setSoloIdentity(null);
    setMetronomeOn(false);
  };

  const toggleMic = async () => {
    const next = !micEnabled;
    setMicEnabled(next);
    if (room) {
      await room.localParticipant.setMicrophoneEnabled(next);
    }
  };

  const toggleCam = async () => {
    const next = !camEnabled;
    setCamEnabled(next);
    if (room) {
      await room.localParticipant.setCameraEnabled(next);
    }
  };

  const startRecording = async () => {
    if (!roomName) {
      return;
    }
    setRecordingError(null);
    try {
      const response = await fetchJson<SessionResponse>(`${apiBaseUrl}/recording/start`, {
        method: "POST",
        headers: {
          "x-master-key": masterKey
        },
        body: JSON.stringify({ room: roomName, syncMode })
      });
      setRecordingSessionId(response.sessionId);
      setRecordingStatus("recording");
      setRecordingStartedAt(Date.now());
      setPlaybackSessionId(null);
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "Failed to start recording");
    }
  };

  const stopRecording = async () => {
    if (!recordingSessionId) {
      return;
    }
    setRecordingError(null);
    try {
      await fetchJson(`${apiBaseUrl}/recording/stop`, {
        method: "POST",
        headers: {
          "x-master-key": masterKey
        },
        body: JSON.stringify({ sessionId: recordingSessionId })
      });
      setRecordingStatus("stopped");
      setRecordingStartedAt(null);
      setPlaybackSessionId(recordingSessionId);
      setRecordingSessionId(null);
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "Failed to stop recording");
    }
  };

  const startProgramOut = async () => {
    if (!roomName) {
      return;
    }
    setProgramError(null);
    try {
      await fetchJson(`${apiBaseUrl}/program/start`, {
        method: "POST",
        headers: {
          "x-master-key": masterKey
        },
        body: JSON.stringify({ roomName })
      });
      setProgramStatus("running");
    } catch (error) {
      setProgramError(error instanceof Error ? error.message : "Failed to start Program Out");
    }
  };

  const stopProgramOut = async () => {
    setProgramError(null);
    try {
      await fetchJson(`${apiBaseUrl}/program/stop`, {
        method: "POST",
        headers: {
          "x-master-key": masterKey
        }
      });
      setProgramStatus("idle");
    } catch (error) {
      setProgramError(error instanceof Error ? error.message : "Failed to stop Program Out");
    }
  };

  const masterControlsVisible = role === "master";
  const canEditSync = role === "master";
  const midiStatusLabel =
    midiStatus === "enabled"
      ? "enabled"
      : midiStatus === "enabling"
        ? "requesting permission"
        : midiStatus === "unsupported"
          ? "unsupported"
          : "idle";

  return (
    <>
      <Head>
        <title>RemoteDJ</title>
        <meta name="description" content="Remote DJ collaboration" />
      </Head>
      <main>
        <div className="header">
          <div className="logo">
            <span className="logo-badge">Remote</span>
            DJ Control Room
          </div>
          <div>
            <strong>{isConnected ? "Live session" : "Not connected"}</strong>
          </div>
        </div>
        <div className="status-strip">
          <div className="status-block">
            <span>Room</span>
            <strong>{isConnected ? activeSessionName ?? roomName : "Not connected"}</strong>
          </div>
          <div className="status-block">
            <span>Sync mode</span>
            <strong>{formatSyncMode(syncMode)}</strong>
          </div>
          <div className="status-block">
            <span>Master</span>
            <strong>{masterIdentity}</strong>
          </div>
          <div className="status-block">
            <span>Recording</span>
            <strong>{recordingStatus}</strong>
          </div>
          <div className="status-block">
            <span>Program Out</span>
            <strong>{programStatus}</strong>
          </div>
        </div>
        {isConnected ? (
          <div className="sync-panel">
            <div className="sync-panel-header">
              <div>
                <div className="section-title">Sync Settings</div>
                <div className="help-text">Session-wide tempo, quantum, and mode.</div>
              </div>
              <span className="status-pill">Sync {syncStatus}</span>
            </div>
            <div className="sync-grid">
              <div className="field">
                <label htmlFor="sync-mode">Mode</label>
                <select
                  id="sync-mode"
                  value={syncMode}
                  onChange={(event) => setSyncMode(event.target.value as SyncMode)}
                  disabled={!canEditSync}
                >
                  <option value="LINK_LAN">Link (LAN)</option>
                  <option value="LINK_WAN">Link (WAN)</option>
                  <option value="MIDI">MIDI</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="sync-tempo">Tempo</label>
                  <input
                    id="sync-tempo"
                    type="number"
                    min={40}
                    max={240}
                    value={syncTempo}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isNaN(next)) {
                        const clamped = Math.max(40, Math.min(240, Math.round(next)));
                        setSyncTempo(clamped);
                        if (syncMode !== "MIDI") {
                          sendLinkProxy({ type: "set", tempo: clamped });
                        }
                      }
                    }}
                    disabled={!canEditSync}
                  />
              </div>
              <div className="field">
                <label htmlFor="sync-quantum">Quantum</label>
                <select
                  id="sync-quantum"
                  value={syncQuantum}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (!Number.isNaN(next)) {
                      const rounded = Math.max(1, Math.round(next));
                      setSyncQuantum(rounded);
                      if (syncMode !== "MIDI") {
                        sendLinkProxy({ type: "set", quantum: rounded });
                      }
                    }
                  }}
                  disabled={!canEditSync}
                >
                  {[1, 2, 3, 4, 6, 8].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Transport</label>
                <div className="recording-row">
                  <button
                    type="button"
                    className={syncTransport === "playing" ? "toggle active" : "toggle"}
                    onClick={() => {
                      setSyncTransport("playing");
                      if (syncMode !== "MIDI") {
                        sendLinkProxy({ type: "set", transport: "playing" });
                      }
                    }}
                    disabled={!canEditSync}
                  >
                    Play
                  </button>
                  <button
                    type="button"
                    className={syncTransport === "paused" ? "toggle active" : "toggle"}
                    onClick={() => {
                      setSyncTransport("paused");
                      if (syncMode !== "MIDI") {
                        sendLinkProxy({ type: "set", transport: "paused" });
                      }
                    }}
                    disabled={!canEditSync}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className={syncTransport === "stopped" ? "toggle active" : "toggle"}
                    onClick={() => {
                      setSyncTransport("stopped");
                      if (syncMode !== "MIDI") {
                        sendLinkProxy({ type: "set", transport: "stopped" });
                      }
                    }}
                    disabled={!canEditSync}
                  >
                    Stop
                  </button>
                </div>
                <div className="help-text">State: {syncTransport}</div>
              </div>
            </div>
            <div className="recording-row">
              <button
                type="button"
                className={metronomeOn ? "toggle active" : "toggle"}
                onClick={() => setMetronomeOn((value) => !value)}
              >
                {metronomeOn ? "Test Sync: On" : "Test Sync"}
              </button>
              <div className="status-pill">
                Metronome {metronomeOn ? "running" : "off"}
              </div>
            </div>
            <div className="sync-readout">
              <div>
                <span>Beat</span>
                <strong>{linkProxyState ? linkProxyState.beat.toFixed(2) : "--"}</strong>
              </div>
              <div>
                <span>Phase</span>
                <strong>{linkProxyState ? linkProxyState.phase.toFixed(2) : "--"}</strong>
              </div>
              <div>
                <span>Peers</span>
                <strong>{linkProxyState ? linkProxyState.numPeers : "--"}</strong>
              </div>
              <div>
                <span>Link Proxy</span>
                <strong>{linkProxyStatus}</strong>
              </div>
            </div>
            {linkProxyError ? <div style={{ color: "var(--danger)" }}>{linkProxyError}</div> : null}
          </div>
        ) : null}

        {!currentUser ? (
          <div className="join-card">
            <div className="section-title">Sign in</div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="login-name">Display name</label>
                <input
                  id="login-name"
                  value={loginName}
                  onChange={(event) => setLoginName(event.target.value)}
                />
              </div>
              <div className="recording-row">
                <button onClick={handleLogin} disabled={!loginName.trim()}>
                  Continue
                </button>
              </div>
              {loginError ? <div style={{ color: "var(--danger)" }}>{loginError}</div> : null}
            </div>
          </div>
        ) : (
          <div className="join-card">
            <div className="session-list-header">
              <div>
                <div className="section-title">Sessions</div>
                <div className="help-text">Signed in as {currentUser.displayName}</div>
              </div>
              <button className="ghost" type="button" onClick={handleLogout}>
                Sign out
              </button>
            </div>
            <div className="session-controls">
              <div className="field">
                <label htmlFor="role">Role</label>
                <select id="role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
                  <option value="master">Master</option>
                  <option value="peer">Peer</option>
                </select>
              </div>
              <div className="field">
                <label>Local devices</label>
                <div className="recording-row">
                  <button
                    type="button"
                    className={micEnabled ? "toggle active" : "toggle"}
                    onClick={toggleMic}
                  >
                    Mic {micEnabled ? "On" : "Off"}
                  </button>
                  <button
                    type="button"
                    className={camEnabled ? "toggle active" : "toggle"}
                    onClick={toggleCam}
                  >
                    Cam {camEnabled ? "On" : "Off"}
                  </button>
                  <div className="status-pill">State: {connectionState}</div>
                </div>
              </div>
            </div>
            <div className="session-create">
              <div className="field">
                <label htmlFor="session-name">New session</label>
                <input
                  id="session-name"
                  value={sessionName}
                  onChange={(event) => setSessionName(event.target.value)}
                />
              </div>
              <button onClick={handleCreateSession}>Create session</button>
            </div>
            {sessionError ? <div style={{ color: "var(--danger)" }}>{sessionError}</div> : null}
            <div className="session-list">
              {sessions.length ? (
                sessions.map((session) => {
                  const isActive = activeSessionId === session.id && isConnected;
                  return (
                    <div key={session.id} className="session-card">
                      <div className="session-info">
                        <div className="session-name">{session.name}</div>
                        <div className="session-meta">
                          <span>Last active {formatTimestamp(session.lastActiveAt)}</span>
                          <span>{session.memberCount} members</span>
                          <span className="status-pill">{session.role}</span>
                        </div>
                      </div>
                      <div className="session-actions">
                        {isActive ? (
                          <>
                            <button className="toggle active" onClick={handleResume}>
                              Resume
                            </button>
                            <button className="ghost" onClick={leaveRoom}>
                              Leave
                            </button>
                          </>
                        ) : (
                          <button onClick={() => joinSession(session)} disabled={isJoining}>
                            {isJoining ? "Joining..." : "Join"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="help-text">No sessions yet. Create one to start.</div>
              )}
            </div>
            {joinError ? <div style={{ color: "var(--danger)" }}>{joinError}</div> : null}
          </div>
        )}

        <div className="join-card midi-card">
          <div className="section-title">MIDI</div>
          <div className="notice">
            WebMIDI support varies by browser. Chrome/Edge are supported; Firefox and Safari often lack
            support. Check MDN or Can I use for the latest matrix.
          </div>
          <div className="help-text">
            Browser support:{" "}
            {midiSupported === null
              ? "checking..."
              : midiSupported
                ? "WebMIDI available"
                : "not supported"}
          </div>
          {midiStatus === "unsupported" ? (
            <div className="notice warning">
              WebMIDI is not available in this browser. Use Chrome or Edge to enable MIDI device access.
            </div>
          ) : null}
          <div className="recording-row">
            <button
              onClick={enableMidi}
              disabled={
                midiStatus === "enabling" || midiStatus === "enabled" || midiStatus === "unsupported"
              }
            >
              {midiStatus === "enabled" ? "MIDI enabled" : "Enable MIDI"}
            </button>
            <div className="status-pill">Status: {midiStatusLabel}</div>
          </div>
          {midiStatus === "enabled" ? (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="midi-input">MIDI input</label>
                <select
                  id="midi-input"
                  value={selectedMidiInputId}
                  onChange={(event) => setSelectedMidiInputId(event.target.value)}
                >
                  {midiInputs.length ? (
                    midiInputs.map((input) => (
                      <option key={input.id} value={input.id}>
                        {input.name || "MIDI Input"}
                      </option>
                    ))
                  ) : (
                    <option value="">No inputs detected</option>
                  )}
                </select>
              </div>
              <div className="field">
                <label htmlFor="midi-output">MIDI output</label>
                <select
                  id="midi-output"
                  value={selectedMidiOutputId}
                  onChange={(event) => setSelectedMidiOutputId(event.target.value)}
                >
                  {midiOutputs.length ? (
                    midiOutputs.map((output) => (
                      <option key={output.id} value={output.id}>
                        {output.name || "MIDI Output"}
                      </option>
                    ))
                  ) : (
                    <option value="">No outputs detected</option>
                  )}
                </select>
              </div>
              <div className="recording-row">
                <button className="ghost" onClick={sendTestNote} disabled={!selectedMidiOutputId}>
                  Send test note
                </button>
                <button
                  className={sendMidiClock ? "toggle active" : "toggle"}
                  type="button"
                  onClick={() => setSendMidiClock((value) => !value)}
                  disabled={!selectedMidiOutputId}
                >
                  {sendMidiClock ? "Clock on" : "Clock off"}
                </button>
                <div className="status-pill">Last MIDI: {lastMidiMessage ?? "--"}</div>
              </div>
              {sendMidiClock ? (
                <div className="help-text">Clock sending at 120 BPM (placeholder).</div>
              ) : null}
              {midiError ? <div style={{ color: "var(--danger)" }}>{midiError}</div> : null}
              <div className="help-text">
                To send MIDI into Ableton, you still need a virtual/loopback MIDI port (IAC on macOS,
                loopMIDI on Windows, ALSA/pipewire on Linux) until a local bridge ships.
              </div>
            </div>
          ) : (
            <div className="help-text">Enable MIDI to choose devices and send messages.</div>
          )}
        </div>

        {masterControlsVisible ? (
          <div className="recording-bar">
            <div className="recording-row">
              <strong>Recording control</strong>
              <span className="status-pill">{recordingStatus}</span>
              {recordingStatus === "recording" ? (
                <span className="rec-timer">⏺ {formatDuration(recordingElapsed)}</span>
              ) : null}
            </div>
            <div className="recording-row">
              <input
                type="password"
                placeholder="Master key"
                value={masterKey}
                onChange={(event) => setMasterKey(event.target.value)}
                style={{ minWidth: 200 }}
              />
              <button
                onClick={startRecording}
                disabled={!isConnected || recordingStatus === "recording" || !masterKey}
              >
                Start recording
              </button>
              <button
                className="secondary"
                onClick={stopRecording}
                disabled={recordingStatus !== "recording" || !masterKey}
              >
                Stop recording
              </button>
            </div>
            {recordingError ? <div style={{ color: "var(--danger)" }}>{recordingError}</div> : null}
            {playbackSessionId ? (
              <div>
                <a className="playback-link" href={`/playback/${playbackSessionId}`}>
                  Open playback for session {playbackSessionId}
                </a>
              </div>
            ) : null}
            <div className="recording-row" style={{ marginTop: "0.6rem" }}>
              <strong>Program Out</strong>
              <span className="status-pill">{programStatus}</span>
            </div>
            <div className="recording-row">
              <button
                onClick={startProgramOut}
                disabled={!isConnected || programStatus === "running" || !masterKey}
              >
                Start Program Out
              </button>
              <button
                className="secondary"
                onClick={stopProgramOut}
                disabled={programStatus !== "running" || !masterKey}
              >
                Stop Program Out
              </button>
            </div>
            {programOutUrl ? (
              <div className="program-url">
                <span>OBS ingest URL</span>
                <code>{programOutUrl}</code>
              </div>
            ) : (
              <div className="help-text">
                Set `NEXT_PUBLIC_PROGRAM_OUT_URL` to display the OBS ingest URL.
              </div>
            )}
            {programError ? <div style={{ color: "var(--danger)" }}>{programError}</div> : null}
          </div>
        ) : null}

        <div className="monitor-bar">
          <div className="recording-row">
            <strong>Audio monitoring</strong>
            <button
              type="button"
              className={monitorMode === "room" ? "toggle active" : "toggle"}
              onClick={toggleRoomMix}
              disabled={!isConnected}
            >
              Room Mix
            </button>
            <div className="status-pill">
              {monitorMode === "off"
                ? "muted"
                : monitorMode === "room"
                  ? "room mix"
                  : `solo ${soloIdentity ?? ""}`}
            </div>
          </div>
          <div className="help-text">
            Monitoring is muted by default to avoid feedback loops. Solo a participant to hear only that
            source.
          </div>
        </div>

        <div className="grid" ref={sessionGridRef}>
          {participants.map((participant, index) => {
            const isLocal = room?.localParticipant?.identity === participant.identity;
            const stats = participantStats.get(participant.identity ?? "");
            const level = audioLevels.get(participant.identity ?? "") ?? 0;
            const channel = participant.identity ? channelAssignments.get(participant.identity) : undefined;
            const controlPlaneRttMs = apiPingError ? 1000 : apiRttMs;
            const effectiveStats: ParticipantStats = {
              rttMs: stats?.rttMs ?? syncRttMs,
              jitterMs: stats?.jitterMs ?? syncJitterMs,
              packetLossPct: stats?.packetLossPct,
              path: stats?.path ?? "unknown"
            };
            const tileConnectionState = isLocal
              ? connectionState === "reconnecting"
                ? "reconnecting"
                : "connected"
              : connectionState === "reconnecting"
                ? "reconnecting"
                : (participant as RemoteParticipant).isConnected
                  ? "connected"
                  : "disconnected";
            return (
              <ParticipantTile
                key={participant.identity ?? (participant as any).sid ?? index}
                participant={participant}
                isLocal={isLocal}
                connectionState={tileConnectionState}
                stats={effectiveStats}
                deviceInfo={isLocal ? deviceInfo : undefined}
                midiLabels={isLocal ? localMidiLabels : undefined}
                syncMode={syncMode}
                midiChannel={channel}
                monitorMode={monitorMode}
                soloIdentity={soloIdentity}
                onSoloToggle={toggleSolo}
                controlPlaneRttMs={controlPlaneRttMs}
                audioLevel={level}
                isRecording={recordingStatus === "recording"}
                version={trackVersion}
              />
            );
          })}
        </div>
      </main>
    </>
  );
};

export default HomePage;
