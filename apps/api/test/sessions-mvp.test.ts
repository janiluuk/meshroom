import { describe, expect, it } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { createStore } from "../src/store";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const baseConfig = () =>
  loadConfig({
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
    DAW_PROJECTS_STORE_PATH: path.join(fixtureDir, ".tmp-daw-projects.json"),
    TIMESHIFT_DIR: path.join(fixtureDir, "timeshift-runs"),
    STORE_PATH: "memory"
  });

const buildTestServer = async () => {
  const config = baseConfig();
  return buildServer(config, {
    store: createStore({ filePath: "memory", persist: false }),
    roomService: { listParticipants: async () => [] },
    egressClient: {
      startTrackEgress: async () => ({ egressId: "egress" }),
      stopEgress: async () => ({ ok: true }),
      startRoomCompositeEgress: async () => ({ egressId: "program" })
    },
    s3Client: { send: async () => ({}) }
  });
};

describe("sessions MVP", () => {
  it("creates session with bpm and quantization", async () => {
    const server = await buildTestServer();

    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { displayName: "Host" }
    });
    const { token } = login.json();

    const response = await server.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Friday Jam", bpm: 124, quantization: 8 }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.session.bpm).toBe(124);
    expect(body.session.quantization).toBe(8);
    expect(body.session.name).toBe("Friday Jam");
  });

  it("returns 403 for export when user is not a member", async () => {
    const server = await buildTestServer();

    const host = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { displayName: "Host" }
    });
    const { token: hostToken } = host.json();

    const session = await server.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { name: "Private" }
    });
    const sessionId = session.json().session.id as string;

    const stranger = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { displayName: "Stranger" }
    });
    const { token: strangerToken } = stranger.json();

    const exportResponse = await server.inject({
      method: "GET",
      url: `/sessions/${sessionId}/export`,
      headers: { authorization: `Bearer ${strangerToken}` }
    });

    expect(exportResponse.statusCode).toBe(403);
  });
});
