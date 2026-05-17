import { createHash } from "crypto";
import { gunzipSync } from "zlib";
import { XMLParser } from "fast-xml-parser";
import { abletonColorFromIndex } from "./colors.js";
import type {
  DawKind,
  ProjectAnalysisManifest,
  ProjectPlugin,
  ProjectPluginFormat,
  ProjectPluginSummary,
  ProjectTrack,
  ProjectTrackType,
  ProjectWarning
} from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) =>
    [
      "AudioTrack",
      "MidiTrack",
      "GroupTrack",
      "ReturnTrack",
      "MainTrack",
      "MidiClip",
      "AudioClip",
      "PluginDevice",
      "AuPluginDevice",
      "VstPluginDevice",
      "Vst3PluginDevice",
      "MxDeviceInstrument",
      "MxDeviceAudioEffect",
      "MxDeviceMidiEffect",
      "Operator",
      "Simpler",
      "MultiSampler"
    ].includes(name)
});

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const textValue = (node: unknown): string | undefined => {
  if (node === undefined || node === null) {
    return undefined;
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (typeof node === "object" && node !== null) {
    const record = node as Record<string, unknown>;
    if ("@_Value" in record) {
      return String(record["@_Value"]);
    }
    if ("@_EffectiveName" in record) {
      return String(record["@_EffectiveName"]);
    }
    if ("#text" in record) {
      return String(record["#text"]);
    }
    for (const value of Object.values(record)) {
      const nested = textValue(value);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
};

const numValue = (node: unknown): number | undefined => {
  const text = textValue(node);
  if (!text) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const pluginFormatFromTag = (tag: string): ProjectPluginFormat => {
  if (tag.includes("Vst3")) {
    return "vst3";
  }
  if (tag.includes("Vst")) {
    return "vst2";
  }
  if (tag.includes("AuPlugin")) {
    return "au";
  }
  if (tag.includes("MxDevice")) {
    return "max";
  }
  return "native";
};

const collectDevices = (node: unknown, acc: ProjectPlugin[]) => {
  if (!node || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "DeviceChain" || key === "MainSequencer" || key === "ClipTimeable") {
      collectDevices(value, acc);
      continue;
    }
    if (
      key.endsWith("Device") ||
      key === "Operator" ||
      key === "Simpler" ||
      key === "MultiSampler" ||
      key === "OriginalSimpler"
    ) {
      const items = asArray(value);
      for (const item of items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const device = item as Record<string, unknown>;
        const name =
          textValue(device.Name) ??
          textValue(device.UserName) ??
          textValue(device["@_Name"]) ??
          key.replace(/Device$/, "");
        const vendor = textValue(device.Vendor) ?? textValue(device.Manufacturer);
        acc.push({
          name: name ?? key,
          vendor,
          format: pluginFormatFromTag(key)
        });
      }
    }
    if (typeof value === "object") {
      collectDevices(value, acc);
    }
  }
};

const collectClips = (trackNode: Record<string, unknown>, trackColor?: string) => {
  const clips: ProjectTrack["clips"] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === "MidiClip" || key === "AudioClip") {
        for (const clip of asArray(value)) {
          if (!clip || typeof clip !== "object") {
            continue;
          }
          const clipRecord = clip as Record<string, unknown>;
          const name = textValue(clipRecord.Name) ?? key;
          const start = numValue(clipRecord.CurrentStart) ?? numValue(clipRecord.LoopStart) ?? 0;
          const end = numValue(clipRecord.CurrentEnd) ?? numValue(clipRecord.LoopEnd) ?? start + 4;
          const colorIndex = numValue(clipRecord.ColorIndex) ?? numValue(clipRecord["@_ColorIndex"]);
          clips.push({
            name,
            startBar: Math.max(1, Math.floor(start / 4) + 1),
            endBar: Math.max(2, Math.floor(end / 4) + 1),
            color: abletonColorFromIndex(colorIndex) ?? trackColor
          });
        }
      } else if (typeof value === "object") {
        walk(value);
      }
    }
  };
  walk(trackNode);
  return clips;
};

const trackTypeFromTag = (tag: string): ProjectTrackType => {
  if (tag === "ReturnTrack") {
    return "return";
  }
  if (tag === "GroupTrack") {
    return "group";
  }
  if (tag === "MainTrack") {
    return "master";
  }
  if (tag === "AudioTrack") {
    return "audio";
  }
  return "midi";
};

const buildPluginsSummary = (tracks: ProjectTrack[]): ProjectPluginSummary[] => {
  const map = new Map<string, ProjectPluginSummary>();
  for (const track of tracks) {
    for (const plugin of track.plugins) {
      const key = `${plugin.format}:${plugin.vendor ?? ""}:${plugin.name}`;
      const existing = map.get(key);
      if (existing) {
        if (!existing.usedOnTracks.includes(track.id)) {
          existing.usedOnTracks.push(track.id);
        }
      } else {
        map.set(key, {
          name: plugin.name,
          vendor: plugin.vendor,
          format: plugin.format,
          usedOnTracks: [track.id]
        });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const collectSampleWarnings = (root: unknown, warnings: ProjectWarning[]) => {
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === "SampleRef" || key === "FileRef") {
        for (const ref of asArray(value)) {
          const path = textValue((ref as Record<string, unknown>)?.RelativePath);
          if (path) {
            warnings.push({
              code: "SAMPLE_PATH",
              message: `Sample reference: ${path}`
            });
          }
        }
      } else if (typeof value === "object") {
        walk(value);
      }
    }
  };
  walk(root);
};

export const detectDawFromFileName = (fileName: string): DawKind | null => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".als")) {
    return "ableton";
  }
  if (lower.endsWith(".flp")) {
    return "flstudio";
  }
  return null;
};

export const parseAlsBuffer = (
  buffer: Buffer,
  fileName: string,
  parsedAt: string
): ProjectAnalysisManifest => {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  let xml: string;
  try {
    xml = gunzipSync(buffer).toString("utf-8");
  } catch {
    throw new Error("Invalid .als file (gzip decompress failed)");
  }

  const doc = parser.parse(xml) as Record<string, unknown>;
  const liveSet = (doc.Ableton as Record<string, unknown> | undefined)?.LiveSet as
    | Record<string, unknown>
    | undefined;
  if (!liveSet) {
    throw new Error("Not a valid Ableton Live Set (missing LiveSet)");
  }

  const tempo =
    numValue((liveSet.Tempo as Record<string, unknown> | undefined)?.Manual?.["@_Value"]) ??
    numValue(liveSet.Tempo);
  const timeSignatureNode = liveSet.TimeSignature as Record<string, unknown> | undefined;
  const numerator = numValue(timeSignatureNode?.Numerator) ?? 4;
  const denominator = numValue(timeSignatureNode?.Denominator) ?? 4;

  const tracksRoot = liveSet.Tracks as Record<string, unknown> | undefined;
  const tracks: ProjectTrack[] = [];
  let trackIndex = 0;

  const trackTags = ["MidiTrack", "AudioTrack", "GroupTrack", "ReturnTrack", "MainTrack"] as const;
  for (const tag of trackTags) {
    for (const trackNode of asArray(tracksRoot?.[tag])) {
      if (!trackNode || typeof trackNode !== "object") {
        continue;
      }
      const record = trackNode as Record<string, unknown>;
      const name = textValue(record.Name) ?? `${tag} ${trackIndex + 1}`;
      const colorIndex = numValue(record.ColorIndex) ?? numValue(record["@_ColorIndex"]);
      const color = abletonColorFromIndex(colorIndex);
      const plugins: ProjectPlugin[] = [];
      collectDevices(record, plugins);
      const clips = collectClips(record, color);
      tracks.push({
        id: `t${trackIndex + 1}`,
        name,
        type: trackTypeFromTag(tag),
        color,
        mute: record["@_Mute"] === "true",
        solo: record["@_Solo"] === "true",
        plugins,
        clips
      });
      trackIndex += 1;
    }
  }

  const warnings: ProjectWarning[] = [];
  collectSampleWarnings(liveSet, warnings);

  const maxEnd = tracks.reduce((max, track) => {
    const trackMax = track.clips.reduce((inner, clip) => Math.max(inner, clip.endBar), 0);
    return Math.max(max, trackMax);
  }, 0);

  const projectName =
    textValue((liveSet as Record<string, unknown>).Name) ??
    fileName.replace(/\.als$/i, "");

  const majorVersion = textValue(
    ((doc.Ableton as Record<string, unknown> | undefined)?.["@_MajorVersion"] as unknown) ??
      ((doc.Ableton as Record<string, unknown> | undefined)?.["@_Version"] as unknown)
  );

  return {
    daw: "ableton",
    dawVersionHint: majorVersion,
    projectName,
    tempo,
    timeSignature: { numerator, denominator },
    lengthBars: maxEnd > 0 ? maxEnd : undefined,
    tracks,
    pluginsSummary: buildPluginsSummary(tracks),
    warnings,
    sourceFile: {
      name: fileName,
      sha256,
      sizeBytes: buffer.length
    },
    parsedAt
  };
};
