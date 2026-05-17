import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import type { ProjectAnalysisManifest } from "./types.js";

const execFileAsync = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultParserScript = path.resolve(moduleDir, "../../../flp-parser/parse_flp.py");

export const resolveFlpParserScript = (override?: string) => {
  if (override && fs.existsSync(override)) {
    return override;
  }
  if (fs.existsSync(defaultParserScript)) {
    return defaultParserScript;
  }
  return defaultParserScript;
};

export const parseFlpBuffer = async (
  buffer: Buffer,
  fileName: string,
  parsedAt: string,
  options?: { parserScript?: string; tempDir?: string }
): Promise<ProjectAnalysisManifest> => {
  const tempDir = options?.tempDir ?? fs.mkdtempSync(path.join("/tmp", "meshroom-flp-"));
  const tempFile = path.join(tempDir, fileName.replace(/[^a-zA-Z0-9._-]/g, "_"));
  fs.writeFileSync(tempFile, buffer);

  const script = resolveFlpParserScript(options?.parserScript);
  try {
    const { stdout } = await execFileAsync("python3", [script, tempFile], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000
    });
    const parsed = JSON.parse(stdout) as ProjectAnalysisManifest;
    parsed.sourceFile = {
      name: fileName,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.length
    };
    parsed.parsedAt = parsedAt;
    parsed.daw = "flstudio";
    return parsed;
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // ignore
    }
  }
};
