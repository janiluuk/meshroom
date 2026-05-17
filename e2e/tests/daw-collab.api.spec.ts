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
  const body = await response.json();
  return body.token as string;
};

test.describe("DAW project visible to peer (API)", () => {
  test.skip(!process.env.E2E_MINIO, "Requires MinIO — run: cd infra && docker compose up -d minio");

  test("peer reads bound session project and checklist", async ({ request }) => {
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
        const body = await statusResponse.json();
        return body.revision.status;
      })
      .toBe("ready");

    const sessionResponse = await request.post(`${apiBaseUrl}/sessions`, {
      headers: { authorization: `Bearer ${hostToken}` },
      data: {
        name: "E2E Session",
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
    const peerBody = await peerProject.json();
    expect(peerBody.analysis.tracks.length).toBeGreaterThan(0);

    const checklist = await request.get(`${apiBaseUrl}/sessions/${session.id}/project/checklist`, {
      headers: { authorization: `Bearer ${peerToken}` }
    });
    expect(checklist.ok()).toBeTruthy();
    expect((await checklist.json()).markdown).toContain("Plugin checklist");
  });
});
