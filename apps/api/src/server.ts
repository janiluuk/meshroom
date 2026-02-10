import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  StreamOutput
} from "livekit-server-sdk";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import type { AppConfig } from "./config";
import type { ActiveSession, ActiveTrack, SessionManifest, SyncMode } from "./manifest";
import { toManifest } from "./manifest";
import { createStore, type Store, type StoredUser } from "./store";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";

type ParticipantInfoLike = {
  identity?: string;
  name?: string;
  tracks?: Array<{
    sid?: string;
    type?: string;
    mimeType?: string;
    name?: string;
  }>;
};

type RoomServiceLike = {
  listParticipants: (roomName: string) => Promise<ParticipantInfoLike[]>;
  listRooms?: () => Promise<Array<{ name?: string }>>;
};

type EgressClientLike = {
  startTrackEgress: (roomName: string, trackId: string, output: EncodedFileOutput) => Promise<{
    egressId?: string;
  }>;
  stopEgress: (egressId: string) => Promise<unknown>;
  startRoomCompositeEgress: (
    roomName: string,
    options: { layout: string; streamOutputs: StreamOutput[] }
  ) => Promise<{ egressId?: string }>;
};

type S3ClientLike = {
  send: (command: unknown) => Promise<any>;
};

type ServerDeps = {
  roomService: RoomServiceLike;
  egressClient: EgressClientLike;
  s3Client: S3ClientLike;
  now: () => Date;
  store: Store;
};

type ProgramOutState = {
  egressId: string;
  roomName: string;
  startedAt: string;
};

type SyncClient = {
  room?: string;
  role?: "master" | "peer";
  isMaster: boolean;
};

type SyncJoinMessage = {
  type: "join";
  room: string;
  role: "master" | "peer";
  masterKey?: string;
};

type SyncStateMessage = {
  type: "state";
  tempo: number;
  transport: "stopped" | "playing" | "paused";
  mode?: "LINK_LAN" | "LINK_WAN" | "MIDI";
  quantum?: number;
  beat?: number;
  phase?: number;
};

type SyncPingMessage = {
  type: "ping";
  sentAt: number;
};

type SyncMessage = SyncJoinMessage | SyncStateMessage | SyncPingMessage;

const recordingContainer = "mp4";
const recordingCodec = "aac";
const recordingFileType = EncodedFileType.MP4;

const buildTrackUrl = (publicUrl: string, bucket: string, fileKey: string) => {
  const base = publicUrl.replace(/\/$/, "");
  return `${base}/${bucket}/${fileKey}`;
};

const streamToString = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

const normalizeTrackKind = (type?: string) => {
  if (!type) {
    return "unknown";
  }
  return type.toLowerCase();
};

const safePathPart = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const isAudioTrack = (kind: string) => kind === "audio";

export const buildServer = (config: AppConfig, deps: Partial<ServerDeps> = {}) => {
  const server = Fastify({
    logger: true
  });

  const now = deps.now ?? (() => new Date());
  const roomService =
    deps.roomService ??
    new RoomServiceClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);
  const egressClient =
    deps.egressClient ??
    new EgressClient(config.livekit.apiUrl, config.livekit.apiKey, config.livekit.apiSecret);
  const s3Client =
    deps.s3Client ??
    new S3Client({
      region: config.minio.region,
      endpoint: config.minio.endpoint,
      forcePathStyle: config.minio.forcePathStyle,
      credentials: {
        accessKeyId: config.minio.accessKey,
        secretAccessKey: config.minio.secretKey
      }
    });
  const store = deps.store ?? createStore({ filePath: config.storePath, now });

  const activeSessions = new Map<string, ActiveSession>();
  let activeProgramOut: ProgramOutState | null = null;

  const getAuthUser = (request: FastifyRequest): StoredUser | null => {
    const header = request.headers.authorization;
    if (!header || Array.isArray(header)) {
      return null;
    }
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return null;
    }
    return store.getUserByToken(token);
  };

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = getAuthUser(request);
    if (!user) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    (request as FastifyRequest & { user?: StoredUser }).user = user;
    return undefined;
  };

  const requireMasterAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.masterKey) {
      return reply.code(500).send({ error: "MASTER_KEY not configured" });
    }

    const provided = request.headers["x-master-key"];
    if (!provided || Array.isArray(provided)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    if (provided !== config.masterKey) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    return undefined;
  };

  server.get("/", async () => ({
    name: "remote-dj-api",
    status: "ok"
  }));

  server.get("/health", async () => ({
    status: "ok"
  }));

  server.get("/ready", async () => ({
    status: "ready"
  }));

  server.get("/ping", async () => ({
    status: "ok",
    now: Date.now()
  }));

  server.post("/auth/login", async (request, reply) => {
    const body = request.body as { displayName?: string };
    const displayName = body?.displayName?.trim();
    if (!displayName) {
      reply.code(400).send({ error: "displayName is required" });
      return;
    }

    const { user, token } = store.login(displayName);
    reply.send({ user, token });
  });

  server.get("/me", { preHandler: requireAuth }, async (request) => {
    const user = (request as FastifyRequest & { user?: StoredUser }).user!;
    return { user };
  });

  server.get("/sessions", { preHandler: requireAuth }, async (request) => {
    const user = (request as FastifyRequest & { user?: StoredUser }).user!;
    return { sessions: store.listSessionsForUser(user.id) };
  });

  server.post("/sessions", { preHandler: requireAuth }, async (request, reply) => {
    const user = (request as FastifyRequest & { user?: StoredUser }).user!;
    const body = request.body as { name?: string };
    const name = body?.name?.trim();
    if (!name) {
      reply.code(400).send({ error: "name is required" });
      return;
    }
    const session = store.createSession(user.id, name);
    reply.send({ session });
  });

  server.post("/sessions/:id/join", { preHandler: requireAuth }, async (request, reply) => {
    const user = (request as FastifyRequest & { user?: StoredUser }).user!;
    const body = request.body as { role?: "master" | "peer" };
    const role = body?.role;
    if (role !== "master" && role !== "peer") {
      reply.code(400).send({ error: "role must be master or peer" });
      return;
    }
    const sessionId = (request.params as { id?: string }).id;
    if (!sessionId) {
      reply.code(400).send({ error: "session id is required" });
      return;
    }
    const session = store.joinSession(user.id, sessionId, role);
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    if (!config.livekit.apiKey || !config.livekit.apiSecret) {
      reply.code(500).send({ error: "LiveKit credentials not configured" });
      return;
    }

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: user.id,
      name: user.displayName
    });
    token.addGrant({
      roomJoin: true,
      room: session.roomName,
      canUpdateOwnMetadata: true
    });

    reply.send({
      token: token.toJwt(),
      room: session.roomName,
      identity: user.id,
      role,
      livekitUrl: config.livekit.url,
      session
    });
  });

  server.post("/auth/token", async (request, reply) => {
    const user = getAuthUser(request);
    if (!user) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const body = request.body as { room?: string; role?: string };
    const room = body?.room?.trim();
    const role = body?.role?.trim();

    if (!room || !role) {
      reply.code(400).send({ error: "room and role are required" });
      return;
    }

    if (role !== "master" && role !== "peer") {
      reply.code(400).send({ error: "role must be master or peer" });
      return;
    }

    if (!config.livekit.apiKey || !config.livekit.apiSecret) {
      reply.code(500).send({ error: "LiveKit credentials not configured" });
      return;
    }

    server.log.info({ event: "auth_token", room, identity: user.id, role }, "Minting LiveKit token");

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: user.id,
      name: user.displayName
    });
    token.addGrant({
      roomJoin: true,
      room,
      canUpdateOwnMetadata: true
    });

    reply.send({
      token: token.toJwt(),
      room,
      identity: user.id,
      role,
      livekitUrl: config.livekit.url
    });
  });

  server.post(
    "/recording/start",
    { preHandler: requireMasterAuth },
    async (request, reply) => {
      const body = request.body as { room?: string; syncMode?: SyncMode };
      const room = body?.room?.trim();
      const syncMode = body?.syncMode ?? "LINK_LAN";

      if (!room) {
        reply.code(400).send({ error: "room is required" });
        return;
      }

      if (!["LINK_LAN", "LINK_WAN", "MIDI"].includes(syncMode)) {
        reply.code(400).send({ error: "syncMode must be LINK_LAN, LINK_WAN, or MIDI" });
        return;
      }

      if (!config.livekit.apiKey || !config.livekit.apiSecret) {
        reply.code(500).send({ error: "LiveKit credentials not configured" });
        return;
      }

      if (!config.minio.accessKey || !config.minio.secretKey) {
        reply.code(500).send({ error: "MinIO credentials not configured" });
        return;
      }

      server.log.info({ event: "recording_start", room }, "Starting recording session");

      const startedAt = now().toISOString();
      const sessionId = randomUUID();

      const participants = await roomService.listParticipants(room);
      if (!participants.length) {
        reply.code(400).send({ error: "no participants in room" });
        return;
      }

      const participantManifests = participants.map((participant) => ({
        identity: participant.identity ?? "unknown",
        name: participant.name ?? undefined
      }));

      const trackManifests: ActiveTrack[] = [];

      for (const participant of participants) {
        const identity = participant.identity ?? "unknown";
        const safeIdentity = safePathPart(identity);
        const trackInfos = participant.tracks ?? [];
        const audioTrack = trackInfos.find((track) => isAudioTrack(normalizeTrackKind(track.type)));
        const trackId = audioTrack?.sid?.trim();

        if (!trackId) {
          server.log.warn({ event: "recording_skip", identity }, "No audio track to record");
          continue;
        }

        const fileKey = `sessions/${sessionId}/${safeIdentity}/audio.${recordingContainer}`;
        const output = new EncodedFileOutput({
          fileType: recordingFileType,
          filepath: fileKey,
          s3: new S3Upload({
            accessKey: config.minio.accessKey,
            secret: config.minio.secretKey,
            region: config.minio.region,
            bucket: config.minio.bucket,
            endpoint: config.minio.endpoint,
            forcePathStyle: config.minio.forcePathStyle
          })
        });

        try {
          // Track egress captures a single LiveKit audio track so each participant becomes its own stem.
          // A room composite egress could be added here later for a master mix if needed.
          const egressInfo = await egressClient.startTrackEgress(room, trackId, output);

          if (!egressInfo.egressId) {
            server.log.error({ event: "recording_egress_error", identity }, "Missing egressId");
            continue;
          }

          const trackStartedAt = now().toISOString();
          trackManifests.push({
            participantIdentity: identity,
            participantName: participant.name ?? undefined,
            kind: "audio",
            url: buildTrackUrl(config.minio.publicUrl, config.minio.bucket, fileKey),
            container: recordingContainer,
            codec: recordingCodec,
            startedAt: trackStartedAt,
            reconnects: [],
            egressId: egressInfo.egressId,
            fileKey
          });
        } catch (error) {
          server.log.error({ error, identity }, "Failed to start track egress");
        }
      }

      if (!trackManifests.length) {
        reply.code(400).send({ error: "no audio tracks available to record" });
        return;
      }

      const manifest: ActiveSession = {
        sessionId,
        room,
        syncMode,
        startedAt,
        participants: participantManifests,
        tracks: trackManifests
      };

      activeSessions.set(sessionId, manifest);

      reply.send({ sessionId });
    }
  );

  server.post(
    "/recording/stop",
    { preHandler: requireMasterAuth },
    async (request, reply) => {
      const body = request.body as { sessionId?: string };
      const sessionId = body?.sessionId?.trim();

      if (!sessionId) {
        reply.code(400).send({ error: "sessionId is required" });
        return;
      }

      const manifest = activeSessions.get(sessionId);
      if (!manifest) {
        reply.code(404).send({ error: "session not found" });
        return;
      }

      server.log.info({ event: "recording_stop", sessionId }, "Stopping recording session");

      const endedAt = now().toISOString();

      for (const track of manifest.tracks) {
        try {
          await egressClient.stopEgress(track.egressId);
        } catch (error) {
          server.log.error({ error, egressId: track.egressId }, "Failed to stop egress");
        }
        track.endedAt = endedAt;
      }

      manifest.endedAt = endedAt;

      const manifestKey = `sessions/${sessionId}/session.json`;
      const storedManifest = toManifest(manifest);

      await s3Client.send(
        new PutObjectCommand({
          Bucket: config.minio.bucket,
          Key: manifestKey,
          Body: JSON.stringify(storedManifest, null, 2),
          ContentType: "application/json"
        })
      );

      activeSessions.delete(sessionId);

      reply.send(storedManifest);
    }
  );

  server.post(
    "/program/start",
    { preHandler: requireMasterAuth },
    async (request, reply) => {
      const body = request.body as { roomName?: string };
      const roomName = body?.roomName?.trim();

      if (!roomName) {
        reply.code(400).send({ error: "roomName is required" });
        return;
      }

      if (!config.programOutUrl) {
        reply.code(500).send({ error: "PROGRAM_OUT_RTMP_URL not configured" });
        return;
      }

      if (!config.livekit.apiKey || !config.livekit.apiSecret) {
        reply.code(500).send({ error: "LiveKit credentials not configured" });
        return;
      }

      if (activeProgramOut) {
        reply
          .code(409)
          .send({ error: "Program Out already running", egressId: activeProgramOut.egressId });
        return;
      }

      const output = new StreamOutput({
        urls: [config.programOutUrl]
      });

      const info = await egressClient.startRoomCompositeEgress(roomName, {
        layout: "grid",
        streamOutputs: [output]
      });

      if (!info.egressId) {
        throw new Error("Program Out did not return an egressId");
      }

      activeProgramOut = {
        egressId: info.egressId,
        roomName,
        startedAt: now().toISOString()
      };

      server.log.info({ event: "program_start", roomName }, "Program Out started");
      reply.send(activeProgramOut);
    }
  );

  server.post(
    "/program/stop",
    { preHandler: requireMasterAuth },
    async (_request, reply) => {
      if (!activeProgramOut) {
        reply.code(404).send({ error: "Program Out not running" });
        return;
      }

      await egressClient.stopEgress(activeProgramOut.egressId);
      const stopped = {
        ...activeProgramOut,
        endedAt: now().toISOString()
      };
      server.log.info({ event: "program_stop", roomName: stopped.roomName }, "Program Out stopped");
      activeProgramOut = null;
      reply.send(stopped);
    }
  );

  server.get("/rooms/:room", async (request, reply) => {
    const room = (request.params as { room?: string }).room?.trim();
    if (!room) {
      reply.code(400).send({ error: "room is required" });
      return;
    }
    try {
      if (!roomService.listRooms) {
        reply.code(501).send({ error: "room lookup not supported" });
        return;
      }
      const rooms = await roomService.listRooms();
      const found = Array.isArray(rooms) ? rooms.find((item: any) => item.name === room) : null;
      if (!found) {
        reply.code(404).send({ error: "room not found" });
        return;
      }
      server.log.info({ event: "room_lookup", room }, "Room info fetched");
      reply.send(found);
    } catch (error) {
      server.log.error({ error, room }, "Failed to fetch room info");
      reply.code(500).send({ error: "Failed to fetch room info" });
    }
  });

  server.get("/sessions/:id", async (request, reply) => {
    const sessionId = (request.params as { id?: string }).id;

    if (!sessionId) {
      reply.code(400).send({ error: "session id is required" });
      return;
    }

    const manifestKey = `sessions/${sessionId}/session.json`;

    try {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: config.minio.bucket,
          Key: manifestKey
        })
      );

      const body = await streamToString(response.Body as Readable);
      const manifest = JSON.parse(body) as SessionManifest;

      reply.send(manifest);
    } catch (error) {
      reply.code(404).send({ error: "session not found" });
    }
  });

  setupSyncPlane(server.server, config);

  return server;
};

const setupSyncPlane = (httpServer: import("http").Server, config: AppConfig) => {
  const wss = new WebSocketServer({ server: httpServer, path: "/sync" });
  const clients = new Map<WebSocket, SyncClient>();
  const rooms = new Map<string, Set<WebSocket>>();

  const removeFromRoom = (socket: WebSocket, room?: string) => {
    if (!room) {
      return;
    }
    const set = rooms.get(room);
    if (!set) {
      return;
    }
    set.delete(socket);
    if (!set.size) {
      rooms.delete(room);
    }
  };

  const sendJson = (socket: WebSocket, payload: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  };

  const broadcast = (room: string, payload: unknown) => {
    const set = rooms.get(room);
    if (!set) {
      return;
    }
    for (const socket of set) {
      sendJson(socket, payload);
    }
  };

  const parseMessage = (data: RawData): SyncMessage | null => {
    try {
      const text = typeof data === "string" ? data : data.toString();
      return JSON.parse(text) as SyncJoinMessage | SyncStateMessage;
    } catch (error) {
      return null;
    }
  };

  wss.on("connection", (socket) => {
    clients.set(socket, { isMaster: false });

    socket.on("message", (data) => {
      const message = parseMessage(data);
      if (!message || typeof message.type !== "string") {
        sendJson(socket, { type: "error", error: "invalid message" });
        return;
      }

      const client = clients.get(socket);
      if (!client) {
        return;
      }

      if (message.type === "join") {
        const join = message as SyncJoinMessage;
        if (!join.room || (join.role !== "master" && join.role !== "peer")) {
          sendJson(socket, { type: "error", error: "invalid join payload" });
          return;
        }
        removeFromRoom(socket, client.room);
        client.room = join.room;
        client.role = join.role;
        client.isMaster = join.role === "master" && join.masterKey === config.masterKey;
        clients.set(socket, client);

        if (!rooms.has(join.room)) {
          rooms.set(join.room, new Set());
        }
        rooms.get(join.room)?.add(socket);

        sendJson(socket, { type: "joined", room: join.room, role: join.role, isMaster: client.isMaster });
        return;
      }

      if (message.type === "state") {
        const state = message as SyncStateMessage;
        if (!client.room) {
          sendJson(socket, { type: "error", error: "not joined" });
          return;
        }
        if (!client.isMaster) {
          sendJson(socket, { type: "error", error: "not authorized" });
          return;
        }
        if (!Number.isFinite(state.tempo) || state.tempo <= 0) {
          sendJson(socket, { type: "error", error: "invalid tempo" });
          return;
        }
        if (!["stopped", "playing", "paused"].includes(state.transport)) {
          sendJson(socket, { type: "error", error: "invalid transport" });
          return;
        }
        if (state.mode && !["LINK_LAN", "LINK_WAN", "MIDI"].includes(state.mode)) {
          sendJson(socket, { type: "error", error: "invalid mode" });
          return;
        }
        if (state.quantum !== undefined && (!Number.isFinite(state.quantum) || state.quantum <= 0)) {
          sendJson(socket, { type: "error", error: "invalid quantum" });
          return;
        }
        if (state.beat !== undefined && !Number.isFinite(state.beat)) {
          sendJson(socket, { type: "error", error: "invalid beat" });
          return;
        }
        if (state.phase !== undefined && !Number.isFinite(state.phase)) {
          sendJson(socket, { type: "error", error: "invalid phase" });
          return;
        }

        broadcast(client.room, {
          type: "state",
          tempo: state.tempo,
          transport: state.transport,
          mode: state.mode,
          quantum: state.quantum,
          beat: state.beat,
          phase: state.phase,
          at: Date.now()
        });
        return;
      }

      if (message.type === "ping") {
        const ping = message as SyncPingMessage;
        if (!Number.isFinite(ping.sentAt)) {
          sendJson(socket, { type: "error", error: "invalid ping" });
          return;
        }
        sendJson(socket, { type: "pong", sentAt: ping.sentAt, serverAt: Date.now() });
      }
    });

    socket.on("close", () => {
      const client = clients.get(socket);
      if (client?.room) {
        removeFromRoom(socket, client.room);
      }
      clients.delete(socket);
    });
  });
};
