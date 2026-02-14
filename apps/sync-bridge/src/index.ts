import http from "http";
import { createRequire } from "module";
import { WebSocketServer, WebSocket } from "ws";

type SyncMode = "LINK_LAN" | "LINK_WAN" | "MIDI";
type SyncRole = "master" | "peer";
type TransportState = "playing" | "paused" | "stopped";

type LinkState = {
  tempo: number;
  beat: number;
  phase: number;
  quantum: number;
  numPeers: number;
};

type LinkAdapter = {
  isAvailable: boolean;
  getState: () => LinkState;
  setTempo: (tempo: number) => void;
  setQuantum: (quantum: number) => void;
  setTransport: (transport: TransportState) => void;
};

type ClientMessage =
  | {
      type: "configure";
      room?: string;
      role?: SyncRole;
      mode?: SyncMode;
      apiUrl?: string;
      masterKey?: string;
    }
  | {
      type: "set";
      tempo?: number;
      quantum?: number;
      transport?: TransportState;
    }
  | {
      type: "ping";
      sentAt: number;
    };

type WanState = {
  tempo: number;
  beat: number;
  phase: number;
  quantum: number;
  transport: TransportState;
  receivedAt: number;
};

type OutgoingState = LinkState & {
  type: "state";
  mode: SyncMode;
  role: SyncRole;
  transport: TransportState;
};

const env = process.env;
const port = Number(env.PORT ?? 3210);
const host = env.HOST ?? "127.0.0.1";
const defaultApiUrl = env.API_SYNC_URL ?? "ws://localhost:4000/sync";
const defaultMasterKey = env.MASTER_KEY ?? "";

const safeNumber = (value: unknown, fallback: number) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const toJson = (value: unknown) => JSON.stringify(value);

const hasCreateFactory = (value: unknown): value is { create: () => unknown } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { create?: unknown }).create === "function";

const readNumber = (target: unknown, keys: string[]): number | undefined => {
  if (!target || typeof target !== "object") {
    return undefined;
  }
  for (const key of keys) {
    const value = (target as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "function") {
      const result = value.call(target);
      if (typeof result === "number" && Number.isFinite(result)) {
        return result;
      }
    }
  }
  return undefined;
};

const createFallbackLink = (): LinkAdapter => {
  let tempo = 120;
  let quantum = 4;
  let transport: TransportState = "stopped";
  let baseBeat = 0;
  let startAt = Date.now();

  const getBeat = () => {
    if (transport !== "playing") {
      return baseBeat;
    }
    const elapsed = (Date.now() - startAt) / 1000;
    return baseBeat + elapsed * (tempo / 60);
  };

  return {
    isAvailable: false,
    getState: () => {
      const beat = getBeat();
      return {
        tempo,
        beat,
        phase: beat % quantum,
        quantum,
        numPeers: 1
      };
    },
    setTempo: (value) => {
      tempo = Math.max(20, value);
    },
    setQuantum: (value) => {
      quantum = Math.max(1, value);
    },
    setTransport: (next) => {
      if (next === transport) {
        return;
      }
      if (next === "playing") {
        baseBeat = getBeat();
        startAt = Date.now();
      } else {
        baseBeat = getBeat();
      }
      transport = next;
    }
  };
};

const createAbletonLinkAdapter = async (): Promise<LinkAdapter> => {
  try {
    const require = createRequire(import.meta.url);
    const module = require("abletonlink");
    const LinkCtor = module.AbletonLink || module.Link || module.default || module;
    const link =
      typeof LinkCtor === "function"
        ? new LinkCtor()
        : hasCreateFactory(LinkCtor)
          ? LinkCtor.create()
          : LinkCtor;

    if (link && typeof link.start === "function") {
      link.start();
    }

    return {
      isAvailable: true,
      getState: () => {
        const tempo = readNumber(link, ["tempo", "getTempo"]) ?? 120;
        const quantum = readNumber(link, ["quantum", "getQuantum"]) ?? 4;
        const beat = readNumber(link, ["beat", "getBeat"]) ?? 0;
        const phase = readNumber(link, ["phase", "getPhase"]) ?? beat % quantum;
        const numPeers = readNumber(link, ["numPeers", "getNumPeers", "numPeersCount"]) ?? 1;
        return {
          tempo,
          beat,
          phase,
          quantum,
          numPeers
        };
      },
      setTempo: (value) => {
        if (typeof link.setTempo === "function") {
          link.setTempo(value);
        } else if ("tempo" in link) {
          link.tempo = value;
        }
      },
      setQuantum: (value) => {
        if (typeof link.setQuantum === "function") {
          link.setQuantum(value);
        } else if ("quantum" in link) {
          link.quantum = value;
        }
      },
      setTransport: (_transport) => {
        if (typeof link.setTransport === "function") {
          link.setTransport(_transport);
        } else if (typeof link.setStartStopSyncEnabled === "function") {
          link.setStartStopSyncEnabled(_transport === "playing");
        }
      }
    };
  } catch (error) {
    console.warn("Ableton Link module not available, falling back to local clock.");
    return createFallbackLink();
  }
};

const main = async () => {
  const link = await createAbletonLinkAdapter();

  let mode: SyncMode = "LINK_LAN";
  let role: SyncRole = "peer";
  let room: string | null = null;
  let apiUrl = defaultApiUrl;
  let masterKey = defaultMasterKey;
  let transport: TransportState = "stopped";
  let wanSocket: WebSocket | null = null;
  let wanState: WanState | null = null;
  let wanSendAt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const clients = new Set<WebSocket>();

  const computeWanState = (state: WanState): LinkState => {
    if (state.transport !== "playing") {
      return {
        tempo: state.tempo,
        beat: state.beat,
        phase: state.phase,
        quantum: state.quantum,
        numPeers: 1
      };
    }
    const elapsed = (Date.now() - state.receivedAt) / 1000;
    const beat = state.beat + elapsed * (state.tempo / 60);
    return {
      tempo: state.tempo,
      beat,
      phase: (state.phase + elapsed * (state.tempo / 60)) % state.quantum,
      quantum: state.quantum,
      numPeers: 1
    };
  };

  const sendToClients = (payload: unknown) => {
    const message = toJson(payload);
    for (const socket of clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  };

  const closeWan = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (wanSocket) {
      wanSocket.removeAllListeners();
      wanSocket.close();
      wanSocket = null;
    }
  };

  const scheduleReconnect = () => {
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWan();
    }, 2000);
  };

  const connectWan = () => {
    if (mode !== "LINK_WAN" || !room) {
      closeWan();
      return;
    }
    closeWan();
    wanSocket = new WebSocket(apiUrl);

    wanSocket.on("open", () => {
      wanSocket?.send(
        toJson({
          type: "join",
          room,
          role,
          masterKey: role === "master" ? masterKey : undefined
        })
      );
    });

    wanSocket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type: string;
          tempo?: number;
          beat?: number;
          phase?: number;
          quantum?: number;
          transport?: TransportState;
          mode?: SyncMode;
        };
        if (message.type === "state" && role === "peer") {
          const tempo = safeNumber(message.tempo, 120);
          const quantum = safeNumber(message.quantum, 4);
          const beat = safeNumber(message.beat, 0);
          const phase = safeNumber(message.phase, beat % quantum);
          const nextTransport = message.transport ?? "playing";
          wanState = {
            tempo,
            beat,
            phase,
            quantum,
            transport: nextTransport,
            receivedAt: Date.now()
          };
          link.setTempo(tempo);
          link.setQuantum(quantum);
          link.setTransport(nextTransport);
          transport = nextTransport;
        }
      } catch (error) {
        // ignore
      }
    });

    wanSocket.on("close", () => {
      scheduleReconnect();
    });

    wanSocket.on("error", () => {
      scheduleReconnect();
    });
  };

  const handleConfigure = (message: ClientMessage & { type: "configure" }) => {
    if (message.room) {
      room = message.room;
    }
    if (message.role === "master" || message.role === "peer") {
      role = message.role;
    }
    if (message.mode && ["LINK_LAN", "LINK_WAN", "MIDI"].includes(message.mode)) {
      mode = message.mode;
    }
    if (message.apiUrl) {
      apiUrl = message.apiUrl;
    }
    if (message.masterKey) {
      masterKey = message.masterKey;
    }
    connectWan();
  };

  const handleSet = (message: ClientMessage & { type: "set" }) => {
    if (typeof message.tempo === "number" && Number.isFinite(message.tempo)) {
      link.setTempo(message.tempo);
    }
    if (typeof message.quantum === "number" && Number.isFinite(message.quantum)) {
      link.setQuantum(Math.max(1, Math.round(message.quantum)));
    }
    if (message.transport) {
      transport = message.transport;
      link.setTransport(message.transport);
    }
  };

  const tick = () => {
    const linkState = mode === "LINK_WAN" && role === "peer" && wanState
      ? computeWanState(wanState)
      : link.getState();

    const outgoing: OutgoingState = {
      type: "state",
      mode,
      role,
      transport,
      tempo: linkState.tempo,
      beat: linkState.beat,
      phase: linkState.phase,
      quantum: linkState.quantum,
      numPeers: linkState.numPeers
    };

    sendToClients(outgoing);

    if (mode === "LINK_WAN" && role === "master" && wanSocket?.readyState === WebSocket.OPEN) {
      const now = Date.now();
      if (now - wanSendAt > 200) {
        wanSendAt = now;
        wanSocket.send(
          toJson({
            type: "state",
            tempo: linkState.tempo,
            beat: linkState.beat,
            phase: linkState.phase,
            quantum: linkState.quantum,
            transport,
            mode
          })
        );
      }
    }
  };

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          link: link.isAvailable ? "abletonlink" : "fallback"
        })
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.send(
      toJson({
        type: "status",
        status: "connected",
        mode,
        role
      })
    );

    socket.on("message", (data) => {
      let message: ClientMessage | null = null;
      try {
        message = JSON.parse(data.toString()) as ClientMessage;
      } catch (error) {
        socket.send(toJson({ type: "error", error: "invalid json" }));
        return;
      }
      if (!message || typeof message.type !== "string") {
        socket.send(toJson({ type: "error", error: "invalid message" }));
        return;
      }
      if (message.type === "configure") {
        handleConfigure(message);
        return;
      }
      if (message.type === "set") {
        handleSet(message);
        return;
      }
      if (message.type === "ping" && typeof message.sentAt === "number") {
        socket.send(toJson({ type: "pong", sentAt: message.sentAt, serverAt: Date.now() }));
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  setInterval(tick, 100);

  server.listen(port, host, () => {
    console.log(`sync-bridge listening on http://${host}:${port}`);
    if (!link.isAvailable) {
      console.log("Ableton Link not detected. Install abletonlink for native Link support.");
    }
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
