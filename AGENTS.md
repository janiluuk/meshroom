# RemoteDJ - Agent Instructions

## Goal
Build a web-based remote DJ/Ableton collaboration app with:
- LiveKit-based WebRTC audio/video
- WebMIDI device selection and MIDI send
- Master-controlled session recording into separate tracks (per participant) + manifest
- Playback page that plays recorded tracks aligned
- OBS-friendly output: provide a simple “Program Out” stream endpoint (SRT or RTMP) for master mix

## Tech choices (do not change without explaining why)
- Frontend: Next.js + TypeScript
- Backend: Node.js (Express or Fastify) + TypeScript
- WebRTC: LiveKit
- Recording/export: LiveKit Egress (participant/track egress)
- Storage: MinIO (S3)
- Cache/coordination: Redis
- Container orchestration: docker-compose

## Non-negotiables
- Must run locally via docker-compose and a single `pnpm dev`
- Must include README with step-by-step run instructions
- Must include .env.example files
- Must include basic health endpoints and a smoke test script
