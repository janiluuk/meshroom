import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3456";
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/minimal.als");

const login = async (request: import("@playwright/test").APIRequestContext, name: string) => {
  const response = await request.post(`${apiBaseUrl}/auth/login`, {
    data: { displayName: name }
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token as string;
};

test.describe("Session MVP (API E2E)", () => {
  test("creates session with BPM and lists timeshift snapshots", async ({ request }) => {
    const token = await login(request, "E2E MVP Host");

    const sessionResponse = await request.post(`${apiBaseUrl}/sessions`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: "MVP Session", bpm: 126, quantization: 8 }
    });
    expect(sessionResponse.ok()).toBeTruthy();
    const { session } = await sessionResponse.json();
    expect(session.bpm).toBe(126);
    expect(session.quantization).toBe(8);

    const joinResponse = await request.post(`${apiBaseUrl}/sessions/${session.id}/join`, {
      headers: { authorization: `Bearer ${token}` },
      data: { role: "master" }
    });
    expect(joinResponse.ok()).toBeTruthy();

    const snapshots = await request.get(`${apiBaseUrl}/sessions/${session.id}/timeshift/snapshots`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(snapshots.ok()).toBeTruthy();
    const snapshotBody = await snapshots.json();
    expect(snapshotBody).toHaveProperty("enabled");
  });

  test("DAW upload bind visible to peer", async ({ request }) => {
    test.skip(!process.env.E2E_MINIO, "Requires MinIO — run: cd infra && docker compose up -d minio");
    test.skip(!fs.existsSync(fixturePath), "missing minimal.als fixture");

    const hostToken = await login(request, "E2E Host");
    const peerToken = await login(request, "E2E Peer");

    const projectResponse = await request.post(`${apiBaseUrl}/projects`, {
      headers: { authorization: `Bearer ${hostToken}` },
      data: { name: "E2E Jam", daw: "ableton" }
    });
    const { project } = await projectResponse.json();

    const uploadResponse = await request.post(`${apiBaseUrl}/projects/${project.id}/revisions`, {
      headers: { authorization: `Bearer ${hostToken}` },
      multipart: {
        file: {
          name: "minimal.als",
          mimeType: "application/octet-stream",
          buffer: fs.readFileSync(fixturePath)
        }
      }
    });
    expect(uploadResponse.status()).toBe(202);
    const { revision } = await uploadResponse.json();

    await expect
      .poll(async () => {
        const statusResponse = await request.get(
          `${apiBaseUrl}/projects/${project.id}/revisions/${revision.id}`,
          { headers: { authorization: `Bearer ${hostToken}` } }
        );
        return (await statusResponse.json()).revision.status;
      })
      .toBe("ready");

    const sessionResponse = await request.post(`${apiBaseUrl}/sessions`, {
      headers: { authorization: `Bearer ${hostToken}` },
      data: {
        name: "DAW E2E",
        projectId: project.id,
        revisionId: revision.id
      }
    });
    const { session } = await sessionResponse.json();

    await request.post(`${apiBaseUrl}/sessions/${session.id}/join`, {
      headers: { authorization: `Bearer ${hostToken}` },
      data: { role: "master" }
    });
    await request.post(`${apiBaseUrl}/sessions/${session.id}/join`, {
      headers: { authorization: `Bearer ${peerToken}` },
      data: { role: "peer" }
    });

    const peerProject = await request.get(`${apiBaseUrl}/sessions/${session.id}/project`, {
      headers: { authorization: `Bearer ${peerToken}` }
    });
    expect(peerProject.ok()).toBeTruthy();
    expect((await peerProject.json()).analysis.tracks.length).toBeGreaterThan(0);
  });
});
