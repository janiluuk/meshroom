/** Procedural background loop shaped by an Every Noise genre label (Web Audio, not recorded). */

export type GenreLoopProfile = {
  genre: string;
  bpm: number;
  swing: number;
  density: number;
  brightness: number;
  rootMidi: number;
  scale: number[];
  kick: number[];
  snare: number[];
  hat: number[];
  bass: number[];
};

const hashString = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const mulberry32 = (seed: number) => {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pickScale = (rng: () => number, genre: string) => {
  const lower = genre.toLowerCase();
  if (/minor|sad|emo|goth|doom|blues/.test(lower)) {
    return [0, 2, 3, 5, 7, 8, 10];
  }
  if (/jazz|soul|funk|r&b|rnb/.test(lower)) {
    return [0, 2, 3, 5, 7, 9, 10];
  }
  if (/arabic|middle eastern|turkish|persian|indian|raag/.test(lower)) {
    return [0, 1, 4, 5, 7, 8, 11];
  }
  if (rng() > 0.55) {
    return [0, 2, 4, 7, 9];
  }
  return [0, 2, 4, 5, 7, 9, 11];
};

const patternFromSeed = (rng: () => number, density: number, steps = 16) => {
  const pattern: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    const chance = i % 4 === 0 ? density + 0.25 : density * 0.65;
    pattern.push(rng() < Math.min(0.95, chance) ? 1 : 0);
  }
  return pattern;
};

const fourOnFloor = () => Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1 : 0));

const applyKeywordHints = (genre: string) => {
  const lower = genre.toLowerCase();
  const hints = {
    swing: 0.08,
    density: 0.55,
    brightness: 0.45,
    bpmScale: 1,
    fourOnFloor: false,
    sparse: false
  };

  if (/jazz|swing|bebop|bossa/.test(lower)) {
    hints.swing = 0.42;
    hints.density = 0.5;
  }
  if (/ambient|drone|meditation|sleep|calm|chill/.test(lower)) {
    hints.density = 0.28;
    hints.bpmScale = 0.82;
    hints.sparse = true;
  }
  if (/techno|house|trance|edm|dance|club|garage|ukg|hardstyle/.test(lower)) {
    hints.fourOnFloor = true;
    hints.density = 0.78;
    hints.brightness = 0.55;
  }
  if (/metal|hardcore|punk|thrash|grind|death/.test(lower)) {
    hints.density = 0.88;
    hints.brightness = 0.72;
    hints.bpmScale = 1.12;
  }
  if (/hip hop|trap|rap|drill|boom bap|grime/.test(lower)) {
    hints.swing = 0.22;
    hints.density = 0.62;
  }
  if (/lofi|lo-fi|study/.test(lower)) {
    hints.density = 0.4;
    hints.bpmScale = 0.88;
    hints.swing = 0.18;
  }
  if (/classical|orchestra|symphon|baroque|romantic/.test(lower)) {
    hints.density = 0.35;
    hints.swing = 0.05;
    hints.bpmScale = 0.9;
  }
  if (/reggae|dub|ska/.test(lower)) {
    hints.swing = 0.35;
    hints.density = 0.58;
  }

  return hints;
};

export const buildGenreLoopProfile = (genre: string, sessionBpm: number): GenreLoopProfile => {
  const seed = hashString(genre.toLowerCase());
  const rng = mulberry32(seed);
  const hints = applyKeywordHints(genre);
  const bpm = Math.round(Math.min(180, Math.max(60, sessionBpm * hints.bpmScale * (0.92 + rng() * 0.16))));
  const density = Math.min(0.92, Math.max(0.15, hints.density + (rng() - 0.5) * 0.2));
  const scale = pickScale(rng, genre);
  const rootMidi = 36 + Math.floor(rng() * 12);

  const kick = hints.fourOnFloor ? fourOnFloor() : patternFromSeed(rng, density + 0.1);
  const snare = hints.sparse
    ? Array.from({ length: 16 }, (_, i) => (i === 8 ? 1 : 0))
    : Array.from({ length: 16 }, (_, i) => (i === 4 || i === 12 ? 1 : rng() < density * 0.15 ? 1 : 0));
  const hat = patternFromSeed(rng, Math.min(0.9, density + 0.2));

  const bass: number[] = [];
  for (let step = 0; step < 16; step += 1) {
    if (!kick[step] && rng() > density) {
      bass.push(0);
      continue;
    }
    const degree = scale[Math.floor(rng() * scale.length)] ?? 0;
    bass.push(rootMidi + degree);
  }

  return {
    genre,
    bpm,
    swing: hints.swing,
    density,
    brightness: hints.brightness,
    rootMidi,
    scale,
    kick,
    snare,
    hat,
    bass
  };
};

type GenreLoopPlayerOptions = {
  onBar?: (barIndex: number) => void;
};

export class GenreLoopPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private barIndex = 0;
  private profile: GenreLoopProfile | null = null;
  private running = false;
  private readonly onBar?: (barIndex: number) => void;

  constructor(options: GenreLoopPlayerOptions = {}) {
    this.onBar = options.onBar;
  }

  isRunning() {
    return this.running;
  }

  getProfile() {
    return this.profile;
  }

  private ensureContext() {
    if (typeof window === "undefined") {
      return null;
    }
    const Ctor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      return null;
    }
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
  }

  setProfile(profile: GenreLoopProfile) {
    this.profile = profile;
  }

  start(profile: GenreLoopProfile) {
    this.stop();
    const ctx = this.ensureContext();
    if (!ctx || !this.master) {
      return;
    }
    this.profile = profile;
    this.running = true;
    this.barIndex = 0;
    this.scheduleBar(ctx);
  }

  stop() {
    this.running = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    this.stop();
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
    this.master = null;
  }

  private scheduleBar(ctx: AudioContext) {
    if (!this.running || !this.profile || !this.master) {
      return;
    }

    const profile = this.profile;
    const barDuration = (60 / profile.bpm) * 4;
    const stepDuration = barDuration / 16;
    const startAt = ctx.currentTime + 0.05;

    for (let step = 0; step < 16; step += 1) {
      const swingOffset = step % 2 === 1 ? profile.swing * stepDuration * 0.5 : 0;
      const time = startAt + step * stepDuration + swingOffset;

      if (profile.kick[step]) {
        this.playKick(ctx, this.master, time, profile.brightness);
      }
      if (profile.snare[step]) {
        this.playSnare(ctx, this.master, time);
      }
      if (profile.hat[step]) {
        this.playHat(ctx, this.master, time, profile.brightness);
      }
      const bassNote = profile.bass[step];
      if (bassNote > 0) {
        this.playBass(ctx, this.master, time, bassNote, stepDuration * 0.9, profile.brightness);
      }
    }

    this.onBar?.(this.barIndex);
    this.barIndex += 1;

    this.timer = window.setTimeout(() => {
      if (this.running) {
        this.scheduleBar(ctx);
      }
    }, Math.max(50, barDuration * 1000 - 30));
  }

  private playKick(ctx: AudioContext, dest: AudioNode, time: number, brightness: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140 + brightness * 40, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.55, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(time);
    osc.stop(time + 0.2);
  }

  private playSnare(ctx: AudioContext, dest: AudioNode, time: number) {
    const bufferSize = Math.floor(ctx.sampleRate * 0.18);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.28, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    noise.start(time);
    noise.stop(time + 0.2);
  }

  private playHat(ctx: AudioContext, dest: AudioNode, time: number, brightness: number) {
    const bufferSize = Math.floor(ctx.sampleRate * 0.04);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 5000 + brightness * 4000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.09, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.035);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    noise.start(time);
    noise.stop(time + 0.05);
  }

  private playBass(
    ctx: AudioContext,
    dest: AudioNode,
    time: number,
    midi: number,
    duration: number,
    brightness: number
  ) {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = brightness > 0.6 ? "sawtooth" : "triangle";
    osc.frequency.value = freq;
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(240 + brightness * 900, time);
    filter.Q.value = 4;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(0.14, time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(time);
    osc.stop(time + duration + 0.02);
  }
}
