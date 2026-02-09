# Meshroom

Web-based remote DJ/Ableton collaboration app for up to 4 people.

- Uses either Ableton Link (through local proxy) or traditional Midi Sync.
- Session room with latency indicators, channel assignments, voice discussions and audio previews individually and together.
- Basic 4-channel mixer controls for each participants.
- Overdubbing individually or together
- WebMIDI support for using your midi controller without external software

Early docker based development version, more accessible installer in plans once core features have been completed.

## Prereqs

- Node.js 18+
- pnpm 9+
- Docker + Docker Compose

## Run It Like You Mean It

1) Install dependencies

```bash
pnpm install
```

2) Create env files

```bash
cp infra/.env.example infra/.env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

3) Start infra (from `/infra`)

```bash
cd infra
docker compose up -d
cd ..
```

Or use `pnpm infra:up` from the repo root.

4) Start apps

```bash
pnpm dev
```

5) Open the web app and join twice (master + peer)

- Web: http://localhost:3000
- API: http://localhost:4000
- API health: http://localhost:4000/health
- API ready: http://localhost:4000/ready
- LiveKit: ws://localhost:7880
- MinIO: http://localhost:9000 (console http://localhost:9001)

6) Start recording, stop, open playback

- Use the master controls to start and stop a recording
- Click the playback link to open the aligned session view

7) Start Program Out and ingest in OBS

- Start Program Out in the master UI
- In OBS, add a Media Source or FFmpeg Source using `PROGRAM_OUT_RTMP_URL`

## API endpoints

- `POST /auth/token` -> `{ room, identity, name?, role }`
- `GET /rooms/:room` -> room info (404 if not found)
- `POST /recording/start` (privileged) -> `{ roomName }`
- `POST /recording/stop` (privileged) -> `{ sessionId }`
- `POST /program/start` (privileged) -> `{ roomName }`
- `POST /program/stop` (privileged)
- `GET /sessions/:id` -> session manifest

Set `MASTER_KEY` in `apps/api/.env`. Use header `x-master-key: <secret>` for privileged endpoints.

### Curl examples

Token minting:

```bash
curl -s http://localhost:4000/auth/token \\
  -H "Content-Type: application/json" \\
  -d '{\"room\":\"studio-1\",\"identity\":\"dj-1\",\"name\":\"DJ 1\",\"role\":\"master\"}'
```

Room lookup:

```bash
curl -s http://localhost:4000/rooms/studio-1
```

Start recording:

```bash
curl -s http://localhost:4000/recording/start \\
  -H "Content-Type: application/json" \\
  -H "x-master-key: $MASTER_KEY" \\
  -d '{\"roomName\":\"studio-1\"}'
```

Stop recording:

```bash
curl -s http://localhost:4000/recording/stop \\
  -H "Content-Type: application/json" \\
  -H "x-master-key: $MASTER_KEY" \\
  -d '{\"sessionId\":\"<session-id>\"}'
```

Start Program Out:

```bash
curl -s http://localhost:4000/program/start \\
  -H "Content-Type: application/json" \\
  -H "x-master-key: $MASTER_KEY" \\
  -d '{\"roomName\":\"studio-1\"}'
```

Stop Program Out:

```bash
curl -s http://localhost:4000/program/stop \\
  -H "x-master-key: $MASTER_KEY"
```

## Program Out (OBS)

Program Out sends a single stream (RTMP) from LiveKit Egress to the URL in `PROGRAM_OUT_RTMP_URL`.

1) Start Program Out from the master UI.
2) In OBS, add a source:
   - Media Source or FFmpeg Source
   - Input the same stream URL from `PROGRAM_OUT_RTMP_URL`
3) Start playback/recording in OBS.

## Smoke test

```bash
pnpm smoke
```

This starts infra and checks container health, API health endpoints, LiveKit reachability, and MinIO bucket presence.

## Notes

- LiveKit config is in `infra/config/livekit.yaml`.
- LiveKit Egress is wired to MinIO for recordings. Adjust S3 settings in `infra/.env`.
- Program Out (RTMP/SRT) output uses `PROGRAM_OUT_RTMP_URL` from `apps/api/.env`.
