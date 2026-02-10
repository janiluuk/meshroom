# Meshroom

Bring back the fun of doing stuff together. It may not sound good always but having a soul is an essence that cannot be learned by any entity.

Meshroom is a web-based remote DJ/Ableton collaboration app for up to 4 people. At minimum it needs human with midi controller and WebMIDI supported browser. Other DAW's with Midi Sync support are supported as well. 

Purpose of this project is to fill the void for live collaboration and music making. If you are familiar with existing choices such as Ninjam, Jamulus or Jamtaba, this has the same core principle but without the technical workload, custom plugins and other fuzz that kills the buzz. Start session, invite people, open your favourite DAW, link your controllers and rest is up to you. 

- Uses either Ableton Link (through local proxy) or traditional Midi Sync.
- Session room with latency indicators, channel assignments, voice discussions and audio previews individually and together.
- Basic 4-channel mixer controls for each participants.
- Looping controls for each individual participants
- Looping controls for whole session for overdubbing or transitions. 
- Users can continue session on same page if they are in the session list and logged in. 
- Selection of groovy loops to start jamming with in case of creative bankrupcy.
- Overdubbing individually or together (e.g. vocalist part over others performance)
- WebMIDI support (For players with just laptop and midi controller). Requires Chrome - compatible browser at this stage.
- OBS Studio support for further broadcasting on live situations.
- User running the master DAW (or e.g. Omnisphere) can map user midi controls to specific VST / AU synth. Current preset name is seen on WebUI.
- By default users are mapped to MIDI channels 2-5. Users can be changed to Omnichannel mode.
- Easy Export results for further processing and mixdown.
- Basic trim, normalization, compression and limiter processing can be added for master or individual channels through quick menu.
- Timeshift to specific state in project, uses git for storing session directory's state.

Early docker based development version, more accessible installer in plans once core features have been completed.

*Tested on Ableton 12.1, Touchable, Midikey Air (bluetooth connection), Arturia Minilab 3 (browser), APC Mini 2 (usb)*


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
- `POST /recording/start` (privileged) -> `{ room }` returns `{ sessionId }`
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
  -d '{\"room\":\"studio-1\"}'
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

Manifest shape:

```json
{
  "room": "studio-1",
  "sessionId": "session-uuid",
  "startedAt": "2024-01-01T00:00:00.000Z",
  "endedAt": "2024-01-01T00:10:00.000Z",
  "participants": [
    { "identity": "dj-1", "name": "DJ 1" }
  ],
  "tracks": [
    {
      "participantIdentity": "dj-1",
      "participantName": "DJ 1",
      "kind": "audio",
      "url": "http://localhost:9000/recordings/sessions/<id>/dj-1/audio.mp4",
      "startOffsetMs": 0
    }
  ]
}
```

## Program Out (OBS)

Program Out sends a single stream (RTMP) from LiveKit Egress to the URL in `PROGRAM_OUT_RTMP_URL`.

1) Start Program Out from the master UI.
2) In OBS, add a source:
   - Click **+** in Sources
   - Choose **Media Source** (or **FFmpeg Source**)
   - Name it `Program Out`
   - Uncheck **Local File**
   - Set the input URL to the exact `PROGRAM_OUT_RTMP_URL`
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
