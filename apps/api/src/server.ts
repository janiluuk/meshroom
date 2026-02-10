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
import type { ActiveSession, ActiveTrack, SessionManifest } from "./manifest";
import { toManifest } from "./manifest";
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
};

type SyncPingMessage = {
  type: "ping";
  sentAt: number;
};

const recordingContainer = "mp4";
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

const createDefaultDeps = (config: AppConfig): ServerDeps => {
  const roomService = new RoomServiceClient(
    config.livekit.apiUrl,
    config.livekit.apiKey,
    config.livekit.apiSecret
  );
  const egressClient = new EgressClient(
    config.livekit.apiUrl,
    config.livekit.apiKey,
    config.livekit.apiSecret
  );
  const s3Client = new S3Client({
    region: config.minio.region,
    endpoint: config.minio.endpoint,
    forcePathStyle: config.minio.forcePathStyle,
    credentials: {
      accessKeyId: config.minio.accessKey,
      secretAccessKey: config.minio.secretKey
    }
  });

  return {
    roomService,
    egressClient,
    s3Client,
    now: () => new Date()
  };
};

export const buildServer = (config: AppConfig, deps?: Partial<ServerDeps>) => {
  const server = Fastify({
    logger: true
  });

  const { roomService, egressClient, s3Client, now } = {
    ...createDefaultDeps(config),
    ...deps
  };

  const activeSessions = new Map<string, ActiveSession>();
  let activeProgramOut: ProgramOutState | null = null;

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

  server.post("/auth/token", async (request, reply) => {
    const body = request.body as { room?: string; identity?: string; name?: string; role?: string };
    const room = body?.room?.trim();
    const identity = body?.identity?.trim();
    const name = body?.name?.trim();
    const role = body?.role?.trim();

    if (!room || !identity || !role) {
      reply.code(400).send({ error: "room, identity, and role are required" });
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

    server.log.info({ event: "auth_token", room, identity, role }, "Minting LiveKit token");

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity,
      name
    });
    token.addGrant({
      roomJoin: true,
      room,
      canUpdateOwnMetadata: true
    });

    reply.send({
      token: token.toJwt(),
      room,
      identity,
      role,
      livekitUrl: config.livekit.url
    });
  });

  server.post(
    "/recording/start",
    { preHandler: requireMasterAuth },
    async (request, reply) => {
      const body = request.body as { room?: string };
      const room = body?.room?.trim();

      if (!room) {
        reply.code(400).send({ error: "room is required" });
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
            startedAt: trackStartedAt,
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

  const parseMessage = (data: RawData) => {
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

        broadcast(client.room, {
          type: "state",
          tempo: state.tempo,
          transport: state.transport,
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
