import { describe, expect, it } from "vitest";
import { gzipSync } from "zlib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatPluginChecklistMarkdown, formatPluginChecklistPlain } from "../src/daw/checklist.js";
import { parseAlsBuffer } from "../src/daw/parse-als.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("plugin checklist", () => {
  it("formats markdown and plain text", () => {
    const xml = fs.readFileSync(path.join(fixtureDir, "minimal.als.xml"), "utf-8");
    const analysis = parseAlsBuffer(gzipSync(xml), "minimal.als", "2026-05-17T00:00:00.000Z");
    const markdown = formatPluginChecklistMarkdown(analysis);
    const plain = formatPluginChecklistPlain(analysis);

    expect(markdown).toContain("# Plugin checklist");
    expect(markdown).toContain("Ableton Live");
    expect(markdown).toContain("[ ]");
    expect(plain).toContain("Plugin checklist");
  });
});
