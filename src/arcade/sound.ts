/**
 * Sounds and songs that games ask Ascy to play. A game runs in a worker,
 * which has no audio, so it sends a description and Ascy synthesizes it
 * (src-tauri/src/audio.rs). Descriptions come from untrusted code: everything
 * is checked and clamped here, and anything malformed is refused with a reason.
 */

export type Wave = "square" | "sawtooth" | "triangle" | "sine" | "noise";
const WAVES: readonly string[] = ["square", "sawtooth", "triangle", "sine", "noise"];

/** One layer of a sound effect, checked */
export interface Tone {
  wave: Wave;
  /** Hz at the start and at the end (the same for a steady pitch) */
  freq: [number, number];
  /** Seconds from the start to silence */
  time: number;
  /** Seconds to full volume, then seconds it stays there before fading */
  attack: number;
  hold: number;
  volume: number;
  /** Low-pass cutoff in Hz at the start and at the end */
  filter: [number, number] | null;
  /** Vibrato: rate in Hz, depth as a fraction of the pitch */
  vibrato: [number, number] | null;
  /** Seconds after the call before it starts */
  delay: number;
}

export interface Instrument {
  wave: Wave;
  volume: number;
  attack: number;
  decay: number;
  /** Volume after the decay, as a fraction of `volume` */
  sustain: number;
  release: number;
  filter: number | null;
  /** Cents */
  detune: number;
  vibrato: [number, number] | null;
  /** Chords are played as a fast arpeggio (the classic chiptune chord) */
  arp: boolean;
  pan: number;
}

/** A note or drum hit starting at some step */
export interface Note {
  /** Hz, several for a chord; empty for a drum hit */
  freqs: number[];
  /** Drum names for a drum hit */
  drums: string[];
  /** Length in steps */
  steps: number;
}

export interface Track {
  instrument: Instrument;
  /** Steps in this track; a shorter track repeats under the longer ones */
  length: number;
  /** Notes starting at each step */
  at: (Note[] | undefined)[];
}

export interface Song {
  bpm: number;
  stepsPerBeat: number;
  loop: boolean;
  volume: number;
  tracks: Track[];
  /** Steps until the song ends or loops: the longest track */
  length: number;
}

export const LIMITS = { layers: 8, time: 3, delay: 2, tracks: 8, steps: 4096, chord: 6 };

/** Ready-made effects for games that don't want to design their own */
export const PRESETS: Record<string, unknown> = {
  blip: { wave: "square", freq: 880, time: 0.06, volume: 0.3 },
  select: [
    { wave: "square", freq: 660, time: 0.05, volume: 0.3 },
    { wave: "square", freq: 990, time: 0.09, delay: 0.05, volume: 0.3 },
  ],
  shoot: { wave: "square", freq: [900, 180], time: 0.16, volume: 0.35 },
  laser: { wave: "sawtooth", freq: [1500, 300], time: 0.2, volume: 0.3, filter: 5000 },
  explosion: { wave: "noise", freq: [4000, 80], time: 0.8, volume: 0.7, filter: [6000, 200] },
  hit: { wave: "noise", freq: [8000, 1500], time: 0.12, volume: 0.45 },
  hurt: { wave: "sawtooth", freq: [420, 110], time: 0.28, volume: 0.4, filter: 2500 },
  pickup: [
    { wave: "square", freq: 988, time: 0.07, volume: 0.28 },
    { wave: "square", freq: 1319, time: 0.16, delay: 0.07, volume: 0.28 },
  ],
  powerup: { wave: "square", freq: [300, 1300], time: 0.45, volume: 0.3, vibrato: [14, 0.04] },
  jump: { wave: "square", freq: [240, 720], time: 0.18, volume: 0.3 },
  error: { wave: "square", freq: 110, time: 0.25, volume: 0.35, vibrato: [22, 0.12] },
};

/** Drum hits for drum tracks: k kick, s snare, h hat, o open hat, c crash, t tom */
export const DRUMS: Record<string, Tone[]> = {
  k: [tone({ wave: "sine", freq: [170, 42], time: 0.24, attack: 0.001, volume: 0.95 }), tone({ wave: "noise", freq: 9000, time: 0.02, volume: 0.25 })],
  s: [tone({ wave: "noise", freq: [12000, 6000], time: 0.17, volume: 0.55, filter: 8000 }), tone({ wave: "triangle", freq: [230, 160], time: 0.09, volume: 0.45 })],
  h: [tone({ wave: "noise", freq: 40000, time: 0.045, volume: 0.22 })],
  o: [tone({ wave: "noise", freq: 40000, time: 0.3, volume: 0.2 })],
  c: [tone({ wave: "noise", freq: [40000, 16000], time: 1, volume: 0.24 })],
  t: [tone({ wave: "sine", freq: [140, 70], time: 0.26, volume: 0.7 })],
};

function fail(message: string): never {
  throw new Error(message);
}

function number(v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${name} must be a number`);
  return Math.min(max, Math.max(min, v));
}

/** A number, or [from, to] for a value that slides */
function range(v: unknown, name: string, min: number, max: number): [number, number] | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") {
    const n = number(v, name, 0, min, max);
    return [n, n];
  }
  if (Array.isArray(v) && v.length === 2) return [number(v[0], name, 0, min, max), number(v[1], name, 0, min, max)];
  return fail(`${name} must be a number or [from, to]`);
}

function wave(v: unknown, name: string): Wave {
  if (v === undefined || v === null) return "square";
  if (typeof v !== "string" || !WAVES.includes(v)) fail(`${name} must be one of ${WAVES.join(", ")}`);
  return v as Wave;
}

function vibrato(v: unknown, name: string): [number, number] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 2) fail(`${name} must be [rate in Hz, depth]`);
  return [number(v[0], name, 0, 0.1, 40), number(v[1], name, 0, 0, 1)];
}

function tone(spec: unknown, name = "sound"): Tone {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail(`${name} must be an object`);
  const s = spec as Record<string, unknown>;
  const w = wave(s.wave, `${name}.wave`);
  const time = number(s.time, `${name}.time`, 0.2, 0.005, LIMITS.time);
  const attack = number(s.attack, `${name}.attack`, 0.003, 0, time);
  return {
    wave: w,
    freq: range(s.freq, `${name}.freq`, 10, w === "noise" ? 44100 : 20000) ?? [w === "noise" ? 8000 : 440, w === "noise" ? 8000 : 440],
    time,
    attack,
    hold: number(s.hold, `${name}.hold`, 0, 0, time - attack),
    volume: number(s.volume, `${name}.volume`, 0.5, 0, 1),
    filter: range(s.filter, `${name}.filter`, 20, 20000),
    vibrato: vibrato(s.vibrato, `${name}.vibrato`),
    delay: number(s.delay, `${name}.delay`, 0, 0, LIMITS.delay),
  };
}

/** A sound effect → its layers. Accepts a preset name, one layer or an array of layers. */
export function toTones(spec: unknown): Tone[] {
  if (typeof spec === "string") {
    if (!(spec in PRESETS)) fail(`no sound preset "${spec}" (there are ${Object.keys(PRESETS).join(", ")})`);
    spec = PRESETS[spec];
  }
  const layers = Array.isArray(spec) ? spec : [spec];
  if (!layers.length || layers.length > LIMITS.layers) fail(`a sound has 1 to ${LIMITS.layers} layers`);
  return layers.map((l, i) => tone(l, layers.length > 1 ? `layer ${i + 1}` : "sound"));
}

// ---------- songs ----------

const NOTE = /^([A-Ga-g])([#b]?)([0-8])$/;
const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const DRUM_NAMES = Object.keys(DRUMS);

function frequency(token: string, transpose: number): number | null {
  const m = NOTE.exec(token);
  if (!m) return null;
  const midi = 12 * (Number(m[3]) + 1) + SEMITONE[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + transpose;
  return 440 * 2 ** ((midi - 69) / 12);
}

function instrument(s: Record<string, unknown>, name: string, drums: boolean): Instrument {
  return {
    wave: drums ? "noise" : wave(s.wave, `${name}.wave`),
    volume: number(s.volume, `${name}.volume`, 0.5, 0, 1),
    attack: number(s.attack, `${name}.attack`, 0.005, 0, 2),
    decay: number(s.decay, `${name}.decay`, 0.1, 0, 4),
    sustain: number(s.sustain, `${name}.sustain`, 0.7, 0, 1),
    release: number(s.release, `${name}.release`, 0.05, 0, 4),
    filter: s.filter === undefined || s.filter === null ? null : number(s.filter, `${name}.filter`, 20000, 20, 20000),
    detune: number(s.detune, `${name}.detune`, 0, -1200, 1200),
    vibrato: vibrato(s.vibrato, `${name}.vibrato`),
    arp: s.arp === true,
    pan: number(s.pan, `${name}.pan`, 0, -1, 1),
  };
}

function track(spec: unknown, name: string): Track {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail(`${name} must be an object`);
  const s = spec as Record<string, unknown>;
  const drums = s.drums === true;
  if (typeof s.notes !== "string") fail(`${name}.notes must be a string of notes`);
  const transpose = Math.round(number(s.transpose, `${name}.transpose`, 0, -48, 48));
  const tokens = s.notes.replace(/\|/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) fail(`${name} has no notes`);
  if (tokens.length > LIMITS.steps) fail(`${name} is longer than ${LIMITS.steps} steps`);
  const at: (Note[] | undefined)[] = new Array(tokens.length);
  let last: Note | null = null;
  tokens.forEach((token, step) => {
    if (token === ".") {
      last = null;
      return;
    }
    if (token === "-") {
      if (last) last.steps++;
      return;
    }
    const parts = token.split("+");
    if (parts.length > LIMITS.chord) fail(`${name}, step ${step + 1}: at most ${LIMITS.chord} notes at once`);
    let note: Note;
    if (drums) {
      for (const p of parts) {
        if (!DRUM_NAMES.includes(p)) fail(`${name}, step ${step + 1}: "${p}" isn't a drum (${DRUM_NAMES.join(" ")}, "." rest)`);
      }
      note = { freqs: [], drums: parts, steps: 1 };
    } else {
      const freqs = parts.map((p) => {
        const f = frequency(p, transpose);
        if (f === null) fail(`${name}, step ${step + 1}: "${p}" isn't a note (like C4, F#3, Bb2; "." rest, "-" hold)`);
        return f;
      });
      note = { freqs, drums: [], steps: 1 };
    }
    at[step] = [note];
    last = note;
  });
  return { instrument: instrument(s, name, drums), length: tokens.length, at };
}

/** A song description → the checked song */
export function toSong(spec: unknown): Song {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail("a song must be an object");
  const s = spec as Record<string, unknown>;
  if (!Array.isArray(s.tracks) || !s.tracks.length) fail("a song needs tracks: [ … ]");
  if (s.tracks.length > LIMITS.tracks) fail(`a song has at most ${LIMITS.tracks} tracks`);
  const tracks = s.tracks.map((t, i) => track(t, `track ${i + 1}`));
  return {
    bpm: number(s.bpm, "bpm", 120, 30, 300),
    stepsPerBeat: Math.round(number(s.steps, "steps", 4, 1, 8)),
    loop: s.loop !== false,
    volume: number(s.volume, "volume", 0.6, 0, 1),
    tracks,
    length: Math.max(...tracks.map((t) => t.length)),
  };
}
