import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";

const decodeBase64Url = (value: string) => {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
};

describe("/auth/token", () => {
  it("mints a LiveKit token with identity and room grant", async () => {
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
      PROGRAM_OUT_RTMP_URL: "rtmp://localhost/live"
    });

    const server = buildServer(config, {
      roomService: { listParticipants: async () => [] },
      egressClient: {
        startTrackEgress: async () => ({ egressId: "egress" }),
        stopEgress: async () => ({ ok: true }),
        startRoomCompositeEgress: async () => ({ egressId: "program" })
      },
      s3Client: { send: async () => ({}) },
      now: () => new Date("2024-01-01T00:00:00.000Z")
    });

    const response = await server.inject({
      method: "POST",
      url: "/auth/token",
      payload: {
        room: "room-a",
        identity: "alice",
        name: "Alice",
        role: "master"
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.room).toBe("room-a");
    expect(body.identity).toBe("alice");
    expect(body.role).toBe("master");
    expect(typeof body.token).toBe("string");

    const [, payload] = body.token.split(".");
    const decoded = JSON.parse(decodeBase64Url(payload));
    expect(decoded.sub).toBe("alice");
    expect(decoded.name).toBe("Alice");
    expect(decoded.grants.room).toBe("room-a");
    expect(decoded.grants.roomJoin).toBe(true);
  });
});
