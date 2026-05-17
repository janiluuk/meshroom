import { describe, expect, it } from "vitest";
import { gzipSync } from "zlib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseAlsBuffer } from "../src/daw/parse-als.js";
import { diffProjectAnalysis } from "../src/daw/diff.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("parseAlsBuffer", () => {
  it("parses minimal Live set fixture", () => {
    const xml = fs.readFileSync(path.join(fixtureDir, "minimal.als.xml"), "utf-8");
    const buffer = gzipSync(xml);
    const analysis = parseAlsBuffer(buffer, "minimal.als", "2026-05-17T00:00:00.000Z");

    expect(analysis.daw).toBe("ableton");
    expect(analysis.tempo).toBe(128);
    expect(analysis.tracks.length).toBeGreaterThanOrEqual(2);
    expect(analysis.tracks.some((track) => track.name === "Bass")).toBe(true);
    expect(analysis.pluginsSummary.some((plugin) => plugin.name.includes("Bass"))).toBe(true);
    expect(analysis.tracks.find((track) => track.name === "Bass")?.clips.length).toBeGreaterThan(0);
  });
});

describe("diffProjectAnalysis", () => {
  it("detects added tracks and plugins", () => {
    const xml = fs.readFileSync(path.join(fixtureDir, "minimal.als.xml"), "utf-8");
    const buffer = gzipSync(xml);
    const a = parseAlsBuffer(buffer, "a.als", "2026-05-17T00:00:00.000Z");
    const b = parseAlsBuffer(buffer, "b.als", "2026-05-17T00:00:00.000Z");
    b.tracks.push({
      id: "t99",
      name: "New Pad",
      type: "midi",
      mute: false,
      solo: false,
      plugins: [{ name: "Serum", format: "vst3" }],
      clips: []
    });
    b.pluginsSummary.push({
      name: "Serum",
      format: "vst3",
      usedOnTracks: ["t99"]
    });

    const diff = diffProjectAnalysis("r1", "r2", a, b);
    expect(diff.tracksAdded).toContain("New Pad");
    expect(diff.pluginsAdded).toContain("Serum");
  });
});
