import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";

describe("recording start", () => {
  it("creates egress jobs for track egress", async () => {
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

    const startedTracks: string[] = [];
    const roomService = {
      listParticipants: async () => [
        {
          identity: "alice",
          tracks: [
            { sid: "audio-1", type: "audio" },
            { sid: "video-1", type: "video" }
          ]
        },
        {
          identity: "bob",
          tracks: [
            { sid: "audio-2", type: "audio" },
            { sid: "data-1", type: "data" }
          ]
        }
      ]
    };
    const egressClient = {
      startTrackEgress: async (_room: string, trackId: string, _output: unknown) => {
        startedTracks.push(trackId);
        return { egressId: `egress-${trackId}` };
      },
      stopEgress: async () => ({ ok: true }),
      startRoomCompositeEgress: async () => ({ egressId: "program-1" })
    };
    const s3Client = {
      send: async () => ({})
    };

    const server = buildServer(config, {
      roomService,
      egressClient,
      s3Client,
      now: () => new Date("2024-01-01T00:00:00.000Z")
    });

    const response = await server.inject({
      method: "POST",
      url: "/recording/start",
      headers: {
        "x-master-key": "master-key"
      },
      payload: {
        room: "room-a"
      }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.sessionId).toBeDefined();
    expect(startedTracks.sort()).toEqual(["audio-1", "audio-2"].sort());
  });
});
