import { describe, expect, it } from "vitest";
import { inferAudioChannel } from "../src/manifest.js";
import { buildStemExportManifest } from "../src/export-stems.js";
import type { SessionManifest } from "../src/manifest.js";

describe("manifest channels", () => {
  it("infers music and voice channels", () => {
    expect(inferAudioChannel(0, 2)).toBe("MUSIC_IN");
    expect(inferAudioChannel(1, 2)).toBe("VOICE");
    expect(inferAudioChannel(0, 1)).toBe("MIX");
  });

  it("builds stem export manifest", () => {
    const manifest: SessionManifest = {
      sessionId: "s1",
      room: "room",
      syncMode: "LINK_LAN",
      startedAt: "2026-05-17T00:00:00.000Z",
      participants: [{ identity: "alice" }],
      tracks: [
        {
          participantIdentity: "alice",
          kind: "audio",
          trackId: "t1",
          channel: "MUSIC_IN",
          url: "http://example/a.mp4",
          container: "mp4",
          codec: "aac",
          startedAt: "2026-05-17T00:00:00.000Z",
          reconnects: [],
          startOffsetMs: 0
        }
      ]
    };
    const exported = buildStemExportManifest(manifest);
    expect(exported.stems[0].fileName).toContain("alice");
    expect(exported.stems[0].channel).toBe("MUSIC_IN");
  });
});
