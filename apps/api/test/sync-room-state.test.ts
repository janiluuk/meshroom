import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { createStore } from "../src/store";

const waitForMessage = (
  socket: WebSocket,
  predicate: (data: Record<string, unknown>) => boolean
) => {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timeout waiting for message"));
    }, 2000);

    socket.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        if (!parsed || typeof parsed !== "object") {
          return;
        }
        if (predicate(parsed)) {
          clearTimeout(timeout);
          resolve(parsed);
        }
      } catch {
        // ignore
      }
    });
  });
};

describe("sync plane roomState", () => {
  it("broadcasts mixer and loop state to peers", async () => {
    const config = loadConfig({
      LIVEKIT_URL: "ws://livekit:7880",
      LIVEKIT_API_URL: "http://livekit:7880",
      LIVEKIT_API_KEY: "key",
      LIVEKIT_API_SECRET: "secret",
      MINIO_ENDPOINT: "http://minio:9000",
      MINIO_ACCESS_KEY: "minio",
      MINIO_SECRET_KEY: "minio",
      MINIO_BUCKET: "recordings",
      MINIO_REGION: "us-east-1",
      MINIO_PUBLIC_URL: "http://minio:9000",
      MASTER_KEY: "master-key",
      PROGRAM_OUT_RTMP_URL: "rtmp://localhost/live",
      PORT: "0",
      HOST: "127.0.0.1"
    });

    const server = await buildServer(config, {
      store: createStore({ filePath: "memory", persist: false }),
      roomService: { listParticipants: async () => [] },
      egressClient: {
        startTrackEgress: async () => ({ egressId: "egress" }),
        stopEgress: async () => ({ ok: true }),
        startRoomCompositeEgress: async () => ({ egressId: "program" })
      },
      s3Client: { send: async () => ({}) }
    });

    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected address");
    }

    const url = `ws://127.0.0.1:${address.port}/sync`;
    const master = new WebSocket(url);
    const peer = new WebSocket(url);

    await new Promise<void>((resolve) => master.on("open", () => resolve()));
    await new Promise<void>((resolve) => peer.on("open", () => resolve()));

    master.send(
      JSON.stringify({
        type: "join",
        room: "studio-2",
        role: "master",
        masterKey: "master-key"
      })
    );
    peer.send(
      JSON.stringify({
        type: "join",
        room: "studio-2",
        role: "peer"
      })
    );

    await waitForMessage(master, (data) => data.type === "joined");
    await waitForMessage(peer, (data) => data.type === "joined");

    master.send(
      JSON.stringify({
        type: "roomState",
        mixer: [
          {
            identity: "alice",
            channel: 1,
            gain: 0.8,
            pan: -0.2,
            mute: false
          }
        ],
        participantLoops: { alice: true },
        sessionLoop: true
      })
    );

    const message = await waitForMessage(peer, (data) => data.type === "roomState");
    expect(message.sessionLoop).toBe(true);
    expect((message.participantLoops as Record<string, boolean>).alice).toBe(true);
    expect((message.mixer as Array<{ gain: number }>)[0].gain).toBe(0.8);

    master.close();
    peer.close();
    await server.close();
  });
});
