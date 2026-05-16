# Meshroom roadmap

Gap analysis as of 2026-05-16. Compares **README / AGENTS goals** against the running codebase (`apps/web`, `apps/api`, `apps/sync-bridge`).

Legend: **done** · **partial** · **missing** · **stub**

---

## MVP (shipped)

| Area | Feature | Status |
|------|---------|--------|
| Platform | docker-compose (LiveKit, Redis, MinIO, egress) | done |
| Platform | `pnpm dev`, `.env.example`, README, smoke script | done |
| API | Auth, sessions, LiveKit tokens, health/ready | done |
| API | Per-participant recording → MinIO + manifest | done |
| API | Program Out (RTMP composite egress) | done |
| API | Sync control plane (WebSocket `/sync`) | done |
| Web | Sign-in, session list, create/join/resume | done |
| Web | LiveKit room (A/V, latency metrics, monitoring) | done |
| Web | Sync modes UI (LINK_LAN / LINK_WAN / MIDI) | done |
| Web | Metronome (local, not recorded) | done |
| Web | Master recording + playback page (aligned stems) | done |
| Web | Program Out controls + OBS URL | done |
| Bridge | sync-bridge WebSocket + Ableton Link adapter (fallback clock) | partial |
| Bridge | M4L OSC stub (outbound test messages only) | stub |

---

## Missing features (gap map)

### Session & collaboration UI

| Feature | README | Code | Notes |
|---------|--------|------|-------|
| Copy session link | ✓ | missing | No clipboard/share control in `index.tsx` |
| Session create (BPM, quantization) | ✓ | missing | Create flow is display-name only; themed UI in screenshots only |
| 4-channel mixer (gain/pan/mute per participant) | ✓ | missing | No mixer UI or API |
| Per-participant looping | ✓ | missing | `loops` only in sample `timeshift/*/session.json` |
| Session-wide looping / overdub | ✓ | missing | `roomMixLoops`, `overdubs` in samples only |
| Groove library | ✓ | partial | Every Noise genre search + procedural background loop (session UI) |
| Every Noise genre loop generator | — | partial | `GET /grooves/genres`, Web Audio in `genreLoop.ts` |
| Themed UI (Mellowyellow / Purplederp) | ✓ | missing | Screenshots in repo root; current UI is minimal |

### MIDI & DAW integration

| Feature | README | Code | Notes |
|---------|--------|------|-------|
| WebMIDI device selection + send | ✓ | partial | Devices + test note; clock hardcoded 120 BPM |
| MIDI mapping UI + snapshots | ✓ | missing | `mappings.json` in timeshift samples only |
| Synth preset name on WebUI | ✓ | missing | OSC stub can send preset; no listener or UI |
| Omnichannel MIDI mode | ✓ | missing | Fixed CH 2–5 display only |
| Vital / Arturia / Serum default maps | planned | missing | README line 48 |
| OSC listener (`127.0.0.1:9123`) | ✓ | missing | Documented in README/M4L README; not in sync-bridge |
| Local MIDI bridge to Ableton | — | missing | Help text: “until a local bridge ships” |
| **Ableton project hosting & analysis** | — | missing | **See [Phase 3](#phase-3-ableton-project-hosting)** |

### Recording, export & playback

| Feature | README | Code | Notes |
|---------|--------|------|-------|
| Separate voice + music tracks per participant | implied | missing | Recording: one audio track per participant |
| Video stems in manifest | — | missing | Live preview only |
| Master mix URL in manifest | — | missing | Playback supports it; recording never sets it |
| Export for DAW (ZIP / stems) | ✓ | partial | JSON stem list download only |
| Trim / normalize / compress / limiter | ✓ | missing | — |
| Program Out SRT | AGENTS | missing | RTMP only today |

### Timeshift & session state

| Feature | README | Code | Notes |
|---------|--------|------|-------|
| Git-backed session snapshots | ✓ | partial | `apps/api/src/timeshift.ts` exists; **not wired** in `server.ts` |
| Timeshift API routes | — | missing | No HTTP surface |
| Timeshift UI (restore / browse) | — | missing | Sample data under `timeshift/` |
| Manifest schema alignment | — | partial | `timeshift` expects `loops`, `overdubs`, `trackId`, `channel`; `manifest.ts` does not |

### Infrastructure & polish

| Feature | README | Code | Notes |
|---------|--------|------|-------|
| Redis in app layer | AGENTS | missing | Infra only; API does not use `REDIS_URL` |
| Cross-platform installer | planned | missing | README: after core features |
| Enforce 4-participant cap | ✓ | missing | Not enforced in API or UI |
| `auth-token` test stability | — | partial | Known failure: token shape (`docs/test-and-screenshot-report.md`) |

---

## Phased roadmap

### Phase 1 — Complete the live session MVP

- Copy session link, session create (BPM + quantization)
- 4-channel mixer (UI + state synced over sync plane)
- Per-participant and session looping controls
- Wire **timeshift** (API + UI): snapshot on record/stop, restore in session
- Fix manifest schema + recording to match timeshift samples
- Separate **voice** vs **music** audio egress per participant

### Phase 2 — DAW & MIDI depth

- OSC listener in sync-bridge; preset/param → WebUI
- MIDI mapping UI + named snapshots (per synth)
- Omnichannel mode; synth default presets (Vital, Arturia, Serum)
- Local MIDI bridge (virtual port → Ableton)
- Real export: ZIP stems + optional master mix; basic loudness processing menu
- Program Out SRT option
- Groove library: upload user loops; richer generation (samples/ML); optional Every Noise playlist links

### Phase 3 — Ableton project hosting

**Goal:** Let a session host upload an Ableton Live Set (`.als`) so collaborators see project structure before and during a jam—plugins in use, track list, and a color-coded timeline aligned with Live’s track colors.

#### User-facing

- Upload `.als` (and optionally linked `.alc` / sample references as metadata-only) to a session or user library
- Project overview page:
  - **Tracks** — name, type (audio/MIDI/group/return), mute/solo/arm flags, color swatch
  - **Plugins** — device/plugin names per track (VST/AU/Max/M4L, native Live devices)
  - **Timeline** — horizontal lanes per track using Ableton’s color index (0–69 → palette), with clip blocks where parseable (name, length, start in bars/beats)
- Versioning: re-upload creates a new revision; link to timeshift snapshot when both exist
- Permission: host-only upload; read-only for guests

#### Technical approach

| Piece | Approach |
|-------|----------|
| Storage | MinIO bucket `projects/{sessionId}/{revision}/` — store original `.als` + derived `manifest.json` |
| Parse | `.als` is gzip-compressed XML; unzip → parse Live Set XML (`Ableton` root, `LiveSet` → `Tracks`, `Devices`, clip slots) |
| Plugin list | Walk device chains per track; collect `PluginDesc` / `AuPluginInfo` / `VstPluginInfo` / M4L device names; dedupe for “required plugins” summary |
| Track colors | Map Live `Color Index` (and RGB when present) to shared palette in web UI |
| Timeline | For each `MidiClip` / `AudioClip` (or arrangement clips): `CurrentStart`, `CurrentEnd`, name, color; render as blocks on a bar/beat axis using set tempo/time signature |
| API | `POST /sessions/:id/project` (upload), `GET /sessions/:id/project`, `GET /sessions/:id/project/analysis` |
| Limits | Max file size, virus scan hook optional, reject encrypted sets if unsupported |

#### Out of scope (initial)

- Opening or editing the project inside the browser
- Resolving missing third-party plugins or auto-installing
- Full sample/media binary hosting (metadata paths only in v1)
- Non-Ableton DAW project formats (may follow same pattern later)

#### Dependencies

- Phase 1 session/host model stable
- MinIO already in stack
- Optional: tie project revision to timeshift commit on upload

### Phase 4 — Distribution & scale

- Cross-platform installer (Docker optional)
- Redis for recording state / multi-instance API
- Playwright E2E suite in CI (see [E2E test plan](#e2e-test-plan-missing))

---

## E2E test plan (missing)

**Today:** `scripts/smoke.sh` checks Docker services, API `/health` + `/ready`, LiveKit, and MinIO bucket. CI runs lint, API unit tests (`vitest`), and `next build`. **No browser or full-stack E2E tests exist.**

| Priority | Flow | Tooling | Notes |
|----------|------|---------|-------|
| P0 | Sign in → create session → join room (master + peer) | Playwright, 2 contexts | LiveKit test credentials or mocked room |
| P0 | Master start/stop recording → manifest in MinIO → open playback URL | Playwright + API poll | Needs infra up; assert aligned stem UI |
| P0 | `GET /grooves/genres` search + random; background loop generate/play/stop | Playwright | Assert panel state; optional `AudioContext` stub |
| P1 | Sync panel: tempo, quantum, transport, LINK/MIDI mode labels | Playwright | Master vs peer permissions |
| P1 | Metronome toggle (local, no recording leak) | Playwright | UI state only unless stream tap added |
| P1 | Program Out start/stop + OBS URL visible | Playwright + API | Privileged `x-master-key` fixture |
| P1 | Session list: resume scroll, leave session | Playwright | Auth cookie/localStorage |
| P1 | Playback: transport, solo/mute, stem download JSON | Playwright | Seed manifest fixture route |
| P2 | WebMIDI enable + device list (Chromium flag) | Playwright | Skip in default CI or use virtual MIDI |
| P2 | Sync WebSocket `/sync`: master state broadcast to peer | Playwright or WS test | RTT/ping optional |
| P2 | sync-bridge health + Link proxy connect | Integration script | Host runner with `pnpm dev:sync` |
| P2 | Visual regression: home + playback vs `docs/app-views/` | Playwright screenshot | Desktop + mobile viewports |
| P3 | Multi-participant mixer / loop controls | Playwright | When UI ships |
| P3 | Timeshift snapshot + restore in session | Playwright | When API wired |
| P3 | Ableton `.als` upload → track/plugin/timeline view | Playwright | When Phase 3 ships |
| P3 | Full `pnpm smoke` in CI (docker-compose on runner) | GitHub Actions service containers | Slow; nightly job |

**Suggested layout:** `e2e/` package with Playwright, `playwright.config.ts`, fixtures for auth token + `MASTER_KEY`, `globalSetup` to run smoke or reuse running stack.

---

## README → implementation quick reference

| README bullet | Status |
|---------------|--------|
| Ableton Link / MIDI sync | partial |
| Latency indicators, channel assignments | partial / done |
| 4-channel mixer | missing |
| Looping (individual + session) | missing |
| Continue session when logged in | done |
| Groove library | partial |
| Overdubbing | missing |
| WebMIDI | partial |
| OBS / Program Out | partial (RTMP) |
| VST mapping + preset on WebUI | missing |
| MIDI CH 2–5 / Omnichannel | partial |
| Export + processing | partial / missing |
| Timeshift (git) | partial |
| **Host & analyze Ableton projects** | **missing (Phase 3)** |

---

## Related docs

- [README.md](../README.md) — product description and runbook
- [AGENTS.md](../AGENTS.md) — build constraints for agents
- [test-and-screenshot-report.md](./test-and-screenshot-report.md) — latest test/screenshot status
- [app-views/](./app-views/) — target UI references (home, playback)
