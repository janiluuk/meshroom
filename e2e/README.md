# Meshroom E2E tests

Playwright tests for API contracts and (optional) browser UI.

## API tests (CI)

CI starts the API automatically on port `3456` and runs session MVP tests (no MinIO required):

```bash
npm run test:e2e:api
```

DAW upload tests need MinIO:

```bash
cd infra && docker compose up -d minio
E2E_MINIO=1 npm run test:e2e:api
```

## Full stack (local)

Terminal 1 — API + web:

```bash
pnpm dev
```

Terminal 2 — UI smoke:

```bash
E2E_STACK=1 WEB_BASE_URL=http://127.0.0.1:3000 API_BASE_URL=http://127.0.0.1:4000 pnpm test:e2e
```

## Projects

| Project | Files | Description |
|---------|-------|-------------|
| `api` | `*.api.spec.ts` | HTTP API against running server |
| `chromium` | `*.ui.spec.ts` | Browser UI (requires `E2E_STACK=1`) |
