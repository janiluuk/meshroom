import { defineConfig } from "@playwright/test";

const apiPort = process.env.E2E_API_PORT ?? "3456";
const apiBaseUrl = process.env.API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.WEB_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "api",
      testMatch: "**/*.api.spec.ts"
    },
    {
      name: "chromium",
      testMatch: "**/*.ui.spec.ts",
      use: { browserName: "chromium" }
    }
  ],
  webServer: [
    {
      command: `bash -c 'cd ../apps/api && PORT=${apiPort} HOST=127.0.0.1 LIVEKIT_API_KEY=test LIVEKIT_API_SECRET=test LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_URL=http://127.0.0.1:7880 MINIO_ACCESS_KEY=minio MINIO_SECRET_KEY=minio MINIO_ENDPOINT=http://127.0.0.1:9000 MASTER_KEY=master-key npm run dev'`,
      url: `${apiBaseUrl}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe"
    }
  ]
});
