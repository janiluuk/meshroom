import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { createStore } from "../src/store";

const waitForMessage = (socket: WebSocket, predicate: (data: any) => boolean) => {
  return new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timeout waiting for message"));
    }, 2000);

    socket.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (predicate(parsed)) {
          clearTimeout(timeout);
          resolve(parsed);
        }
      } catch (error) {
        // ignore
      }
    });
  });
};

describe("sync plane", () => {
  it("broadcasts master tempo and transport to peers", async () => {
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

    const server = buildServer(config, {
      store: createStore({ filePath: "memory", persist: false }),
      roomService: { listParticipants: async () => [] },
      egressClient: {
        startTrackEgress: async () => ({ egressId: "egress" }),
        stopEgress: async () => ({ ok: true }),
        startRoomCompositeEgress: async () => ({ egressId: "program" })
      },
      s3Client: { send: async () => ({}) },
      now: () => new Date("2024-01-01T00:00:00.000Z")
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
        room: "studio-1",
        role: "master",
        masterKey: "master-key"
      })
    );
    peer.send(
      JSON.stringify({
        type: "join",
        room: "studio-1",
        role: "peer"
      })
    );

    await waitForMessage(master, (data) => data.type === "joined");
    await waitForMessage(peer, (data) => data.type === "joined");

    master.send(
      JSON.stringify({
        type: "state",
        tempo: 128,
        transport: "playing"
      })
    );

    const message = await waitForMessage(peer, (data) => data.type === "state");
    expect(message.tempo).toBe(128);
    expect(message.transport).toBe("playing");

    master.close();
    peer.close();
    await server.close();
  });
});
