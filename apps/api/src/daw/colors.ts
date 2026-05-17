/** Ableton Live color index 0–69 → hex (approximate Live 11 palette). */
const ABLETON_PALETTE = [
  "#ff94ed", "#c66363", "#ff3636", "#b21212", "#ff9636", "#ff5000", "#ff897f", "#cc4400",
  "#fffa37", "#d4a619", "#dada03", "#d6b401", "#a0e619", "#9ddb04", "#00ff00", "#1fc437",
  "#00ff89", "#00bf5f", "#00ffbf", "#00ddb0", "#00ffff", "#00a9a9", "#00b6ff", "#0099ff",
  "#007fff", "#0050ff", "#0000ff", "#0000bf", "#5000ff", "#7f00ff", "#bf00ff", "#ff00ff",
  "#ff00bf", "#ff0080", "#ff0040", "#ff8099", "#ff80bf", "#ff80ff", "#bf80ff", "#8080ff",
  "#80bfff", "#80ffff", "#80ffbf", "#80ff80", "#bfff80", "#ffff80", "#ffbf80", "#ff8080",
  "#999999", "#666666", "#434343", "#1a1a1a", "#ffffff", "#ff0000", "#00ff00", "#0000ff",
  "#ffff00", "#00ffff", "#ff00ff", "#ff8800", "#88ff00", "#0088ff", "#8800ff", "#888888",
  "#444444", "#222222", "#cccccc", "#aaaaaa"
];

export const abletonColorFromIndex = (index: number | undefined): string | undefined => {
  if (index === undefined || Number.isNaN(index)) {
    return undefined;
  }
  const clamped = Math.max(0, Math.min(ABLETON_PALETTE.length - 1, Math.floor(index)));
  return ABLETON_PALETTE[clamped];
};

const FL_PALETTE = [
  "#ff5555", "#ffaa00", "#ffff00", "#00ff00", "#00aaaa", "#5555ff", "#aa00ff", "#ff00ff",
  "#888888", "#cccccc", "#ff8080", "#80ff80", "#8080ff", "#ffff80", "#80ffff", "#ff80ff"
];

export const flColorFromIndex = (index: number | undefined): string | undefined => {
  if (index === undefined || Number.isNaN(index)) {
    return undefined;
  }
  return FL_PALETTE[Math.abs(index) % FL_PALETTE.length];
};
