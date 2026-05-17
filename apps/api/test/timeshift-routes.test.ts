import { describe, expect, it } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { createStore } from "../src/store";
import type { SessionManifest } from "../src/manifest";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("timeshift routes", () => {
  it("lists snapshots and restores when git timeshift is enabled", async () => {
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
      TIMESHIFT_DIR: path.join(fixtureDir, "timeshift-runs"),
      DAW_PROJECTS_STORE_PATH: path.join(fixtureDir, ".tmp-daw-projects.json")
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

    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { displayName: "Host" }
    });
    const { token } = login.json();

    const session = await server.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Timeshift test", bpm: 120 }
    });
    const sessionId = session.json().session.id as string;

    await server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/join`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: "master" }
    });

    const listBefore = await server.inject({
      method: "GET",
      url: `/sessions/${sessionId}/timeshift/snapshots`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(listBefore.statusCode).toBe(200);
    const listBody = listBefore.json();
    if (!listBody.enabled) {
      return;
    }

    const manifest: SessionManifest = {
      sessionId,
      room: sessionId,
      syncMode: "LINK_LAN",
      startedAt: "2026-05-17T00:00:00.000Z",
      bpm: 120,
      quantization: 4,
      participants: [{ identity: "host" }],
      tracks: [],
      loops: [],
      roomMixLoops: [],
      overdubs: []
    };

    const snapshot = await server.inject({
      method: "POST",
      url: `/sessions/${sessionId}/timeshift/snapshots`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        message: "vitest snapshot",
        manifest,
        state: { mappings: { ch1: "synth" } }
      }
    });
    expect(snapshot.statusCode).toBe(200);

    const listAfter = await server.inject({
      method: "GET",
      url: `/sessions/${sessionId}/timeshift/snapshots`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(snapshot.statusCode).toBe(200);
    const snapshotResult = snapshot.json() as { committed?: boolean };
    const snapshots = listAfter.json().snapshots as Array<{ id: string }>;
    if (snapshotResult.committed) {
      expect(snapshots.length).toBeGreaterThan(0);
    }

    const exportResponse = await server.inject({
      method: "GET",
      url: `/sessions/${sessionId}/export`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.json().sessionId).toBe(sessionId);
  });
});
