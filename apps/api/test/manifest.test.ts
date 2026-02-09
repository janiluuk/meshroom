import { describe, expect, it } from "vitest";
import type { ActiveSession } from "../src/manifest";
import { toManifest } from "../src/manifest";

describe("manifest creation", () => {
  it("strips egress-only fields and preserves timing", () => {
    const session: ActiveSession = {
      sessionId: "session-123",
      roomName: "room-a",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: "2024-01-01T00:05:00.000Z",
      participants: [
        {
          identity: "alice",
          tracks: [
            {
              trackId: "track-a",
              kind: "audio",
              url: "http://minio/sessions/session-123/alice/track-a.mp4",
              container: "mp4",
              codec: "aac",
              startedAt: "2024-01-01T00:00:01.000Z",
              endedAt: "2024-01-01T00:05:00.000Z",
              reconnectMarkers: [],
              egressId: "egress-1",
              fileKey: "sessions/session-123/alice/track-a.mp4"
            }
          ]
        }
      ]
    };

    const manifest = toManifest(session);

    expect(manifest).toEqual({
      sessionId: "session-123",
      roomName: "room-a",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: "2024-01-01T00:05:00.000Z",
      participants: [
        {
          identity: "alice",
          tracks: [
            {
              trackId: "track-a",
              kind: "audio",
              url: "http://minio/sessions/session-123/alice/track-a.mp4",
              container: "mp4",
              codec: "aac",
              startedAt: "2024-01-01T00:00:01.000Z",
              endedAt: "2024-01-01T00:05:00.000Z",
              reconnectMarkers: []
            }
          ]
        }
      ]
    });
  });
});
