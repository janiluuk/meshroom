import { describe, expect, it } from "vitest";
import { gzipSync } from "zlib";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import { createStore } from "../src/store";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const testConfig = () =>
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
    DAW_PROJECTS_STORE_PATH: path.join(fixtureDir, ".tmp-daw-projects.json")
  });

describe("DAW session collaboration", () => {
  it("binds project on session create and exposes analysis to session members", async () => {
    const config = testConfig();
    const s3Bodies = new Map<string, Buffer>();

    const server = await buildServer(config, {
      store: createStore({ filePath: "memory", persist: false }),
      roomService: { listParticipants: async () => [] },
      egressClient: {
        startTrackEgress: async () => ({ egressId: "egress" }),
        stopEgress: async () => ({ ok: true }),
        startRoomCompositeEgress: async () => ({ egressId: "program" })
      },
      s3Client: {
        send: async (command: { input?: { Key?: string; Body?: Buffer } }) => {
          const key = command.input?.Key;
          const body = command.input?.Body;
          if (key && body) {
            s3Bodies.set(key, body);
            return {};
          }
          if (key && s3Bodies.has(key)) {
            return { Body: Readable.from(s3Bodies.get(key)!) };
          }
          return {};
        }
      }
    });

    const hostLogin = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { displayName: "Host" }
    });
    const { token: hostToken, user: hostUser } = hostLogin.json();

    const projectResponse = await server.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { name: "Jam", daw: "ableton" }
    });
    const { project } = projectResponse.json();

    const xml = fs.readFileSync(path.join(fixtureDir, "minimal.als.xml"), "utf-8");
    const boundary = "----meshroom";
    const uploadBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="minimal.als"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ),
      gzipSync(xml),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const uploadResponse = await server.inject({
      method: "POST",
      url: `/projects/${project.id}/revisions`,
      headers: {
        authorization: `Bearer ${hostToken}`,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: uploadBody
    });
    expect(uploadResponse.statusCode).toBe(202);
    const { revision } = uploadResponse.json();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const revisionReady = await server.inject({
      method: "GET",
      url: `/projects/${project.id}/revisions/${revision.id}`,
      headers: { authorization: `Bearer ${hostToken}` }
    });
    expect(revisionReady.json().revision.status).toBe("ready");

    const sessionResponse = await server.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: `Bearer ${hostToken}` },
      payload: {
        name: "Collab",
        projectId: project.id,
        revisionId: revision.id
      }
    });
    expect(sessionResponse.statusCode).toBe(200);
    const { session, projectBinding } = sessionResponse.json();
    expect(projectBinding?.revision.id).toBe(revision.id);

    await server.inject({
      method: "POST",
      url: `/sessions/${session.id}/join`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { role: "master" }
    });

    const peerLogin = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { displayName: "Peer" }
    });
    const { token: peerToken } = peerLogin.json();

    await server.inject({
      method: "POST",
      url: `/sessions/${session.id}/join`,
      headers: { authorization: `Bearer ${peerToken}` },
      payload: { role: "peer" }
    });

    const peerProject = await server.inject({
      method: "GET",
      url: `/sessions/${session.id}/project`,
      headers: { authorization: `Bearer ${peerToken}` }
    });
    expect(peerProject.statusCode).toBe(200);
    expect(peerProject.json().analysis?.projectName).toBeTruthy();

    const checklist = await server.inject({
      method: "GET",
      url: `/sessions/${session.id}/project/checklist`,
      headers: { authorization: `Bearer ${peerToken}` }
    });
    expect(checklist.statusCode).toBe(200);
    expect(checklist.json().markdown).toContain("Plugin checklist");

    const revisionChecklist = await server.inject({
      method: "GET",
      url: `/projects/${project.id}/revisions/${revision.id}/checklist`,
      headers: { authorization: `Bearer ${hostToken}` }
    });
    expect(revisionChecklist.statusCode).toBe(200);
    expect(revisionChecklist.json().pluginCount).toBeGreaterThan(0);

    expect(hostUser.id).toBeTruthy();
  });
});
