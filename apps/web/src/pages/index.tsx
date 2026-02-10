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

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const midiInputStorageKey = "remote-dj:midi-input";
const midiOutputStorageKey = "remote-dj:midi-output";
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

const getNetworkQuality = (
  rttMs?: number,
  jitterMs?: number,
  packetLossPct?: number
): { label: string; className: string } => {
  if (rttMs === undefined && jitterMs === undefined && packetLossPct === undefined) {
    return { label: "unknown", className: "quality-badge unknown" };
  }
  const loss = packetLossPct ?? 0;
  const rtt = rttMs ?? 0;
  const jitter = jitterMs ?? 0;
  if (rtt < 120 && jitter < 30 && loss < 1) {
    return { label: "good", className: "quality-badge good" };
  }
  if (rtt < 250 && jitter < 60 && loss < 3) {
    return { label: "fair", className: "quality-badge fair" };
  }
  return { label: "poor", className: "quality-badge poor" };
};

const formatDuration = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const fetchJson = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
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
  const identity = participant.identity || "Guest";
  const metadata = parseParticipantMeta(participant.metadata);
  const roleBadge = metadata?.role || (isLocal ? "local" : "peer");
  const showAvatar = !videoTrack || videoPublication?.isMuted;
  const audioLevelValue = Math.min(Math.max(audioLevel ?? 0, 0), 1);
  const quality = getNetworkQuality(stats?.rttMs, stats?.jitterMs, stats?.packetLossPct);
  const pathLabel =
    stats?.path === "relay" ? "Relay" : stats?.path === "p2p" ? "P2P" : "Unknown";

  return (
    <div className="tile">
      <div className="tile-media">
        {showAvatar ? (
          <div className="avatar">
            <span>{getInitials(identity)}</span>
          </div>
        ) : (
          <video ref={videoRef} muted={isLocal} playsInline />
        )}
        <audio ref={audioRef} muted={isLocal} />
      </div>
      <div>
        <div className="tile-header">
          <div className="tile-name">{identity}</div>
          <div className="tile-header-right">
            {isRecording ? <span className="rec-pill">REC</span> : null}
            <div className="status-pill">{connectionState}</div>
          </div>
        </div>
        <div className="tile-sub">
          <span className="role-badge">{roleBadge}</span>
          <span className={quality.className}>{quality.label}</span>
          {isLocal ? <span className="status-pill">You</span> : null}
        </div>
        <div className="tile-body">
          <div className="audio-meter">
            <div className="audio-meter-fill" style={{ width: `${audioLevelValue * 100}%` }} />
          </div>
          <div className="metric">
            <span>Connection</span>
            <strong>{ConnectionQuality[connectionQuality]}</strong>
          </div>
          <div className="metric">
            <span>Latency</span>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
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
          <div className="device-list">
            <div>Cam: {deviceInfo?.cam || metadata?.devices?.cam || (isLocal ? "--" : "Remote")}</div>
            <div>Mic: {deviceInfo?.mic || metadata?.devices?.mic || (isLocal ? "--" : "Remote")}</div>
            <div>Output: {deviceInfo?.output || metadata?.devices?.output || (isLocal ? "--" : "Remote")}</div>
            <div>
              MIDI In: {midiLabels?.input || metadata?.devices?.midiIn || (isLocal ? "--" : "Remote")}
            </div>
            <div>
              MIDI Out: {midiLabels?.output || metadata?.devices?.midiOut || (isLocal ? "--" : "Remote")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const HomePage = () => {
  const [roomName, setRoomName] = useState("studio-1");
  const [identity, setIdentity] = useState("dj-" + Math.floor(Math.random() * 1000));
  const [role, setRole] = useState<Role>("peer");
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [deviceInfo, setDeviceInfo] = useState<DeviceSnapshot>({});
  const [participantStats, setParticipantStats] = useState<Map<string, ParticipantStats>>(new Map());
  const [trackVersion, setTrackVersion] = useState(0);
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
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
  const syncSocketRef = useRef<WebSocket | null>(null);
  const syncIntervalRef = useRef<number | null>(null);
  const syncRttHistoryRef = useRef<number[]>([]);
  const syncPingIntervalRef = useRef<number | null>(null);

  const updateParticipants = useCallback((currentRoom: Room) => {
    const list = [currentRoom.localParticipant, ...Array.from(currentRoom.remoteParticipants.values())];
    setParticipants(list);
  }, []);

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
  }, [room, role, deviceInfo, localMidiLabels]);

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
          sentAt?: number;
        };
        if (message.type === "state") {
          if (typeof message.tempo === "number") {
            setSyncTempo(message.tempo);
          }
          if (message.transport) {
            setSyncTransport(message.transport);
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
    if (role !== "master" || syncStatus !== "connected") {
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
          transport: syncTransport
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
  }, [role, syncStatus, syncTempo, syncTransport]);

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

  const joinRoom = async () => {
    setJoinError(null);
    setIsJoining(true);

    try {
      const response = await fetchJson<{ token: string; livekitUrl: string }>(
        `${apiBaseUrl}/auth/token`,
        {
          method: "POST",
          body: JSON.stringify({ room: roomName, identity, name: identity, role })
        }
      );

      const newRoom = new Room({
        adaptiveStream: true,
        dynacast: true
      });

      newRoom.on(RoomEvent.Disconnected, () => {
        setRoom(null);
        setParticipants([]);
        setConnectionState("disconnected");
      });

      await newRoom.connect(response.livekitUrl, response.token);
      await newRoom.localParticipant.setMicrophoneEnabled(micEnabled);
      await newRoom.localParticipant.setCameraEnabled(camEnabled);

      setRoom(newRoom);
      updateParticipants(newRoom);

      const info = await getDeviceSnapshot();
      setDeviceInfo(info);
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : "Failed to join");
    } finally {
      setIsJoining(false);
    }
  };

  const leaveRoom = async () => {
    if (room) {
      await room.disconnect();
    }
    setRoom(null);
    setParticipants([]);
    setConnectionState("disconnected");
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
        body: JSON.stringify({ room: roomName })
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

  const isConnected = Boolean(room);
  const masterControlsVisible = role === "master";
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
            <strong>{isConnected ? `Connected: ${roomName}` : "Not connected"}</strong>
          </div>
        </div>
        <div className="session-bar">
          <div className="session-item">
            <span>Tempo</span>
            <strong>{syncTempo} BPM</strong>
          </div>
          <div className="session-item">
            <span>Transport</span>
            <strong>{syncTransport}</strong>
          </div>
          <div className="session-item">
            <span>Quantize</span>
            <strong>1/8</strong>
          </div>
        </div>

        <div className="join-card">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="room">Room name</label>
              <input
                id="room"
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="identity">Display name</label>
              <input
                id="identity"
                value={identity}
                onChange={(event) => setIdentity(event.target.value)}
              />
            </div>
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
            <div className="recording-row">
              {!isConnected ? (
                <button onClick={joinRoom} disabled={isJoining}>
                  {isJoining ? "Joining..." : "Join room"}
                </button>
              ) : (
                <button className="ghost" onClick={leaveRoom}>
                  Leave room
                </button>
              )}
            </div>
            {joinError ? <div style={{ color: "var(--danger)" }}>{joinError}</div> : null}
          </div>
        </div>

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

        <div className="grid">
          {participants.map((participant, index) => {
            const isLocal = room?.localParticipant?.identity === participant.identity;
            const stats = participantStats.get(participant.identity ?? "");
            const level = audioLevels.get(participant.identity ?? "") ?? 0;
            const effectiveStats: ParticipantStats = {
              rttMs: syncRttMs ?? stats?.rttMs,
              jitterMs: syncJitterMs ?? stats?.jitterMs,
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
