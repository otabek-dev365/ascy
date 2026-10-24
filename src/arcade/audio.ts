import { invoke } from "@tauri-apps/api/core";
import { DRUMS, type Instrument, type Song, type Tone, toSong, toTones } from "./sound";

const num = (v: unknown, def: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;

/** What the Rust side (src-tauri/src/audio.rs) is told, in order */
type Op =
  | { op: "sound"; tones: Tone[]; volume: number; pan: number; rate: number }
  | { op: "music"; song: WireSong | null }
  | { op: "volume"; volume: number }
  | { op: "hidden"; hidden: boolean }
  | { op: "stop" }
  | { op: "close" }
  | { op: "reset" };

interface WireSong {
  bpm: number;
  stepsPerBeat: number;
  loop: boolean;
  volume: number;
  length: number;
  kit: Tone[][];
  tracks: { instrument: Instrument; length: number; notes: { at: number; freqs: number[]; drums: number[]; steps: number }[] }[];
}

const DRUM_NAMES = Object.keys(DRUMS);

/** A song as the Rust side takes it: notes listed by step, drums by number */
function wire(song: Song): WireSong {
  return {
    bpm: song.bpm,
    stepsPerBeat: song.stepsPerBeat,
    loop: song.loop,
    volume: song.volume,
    length: song.length,
    kit: DRUM_NAMES.map((d) => DRUMS[d]),
    tracks: song.tracks.map((t) => ({
      instrument: t.instrument,
      length: t.length,
      notes: t.at.flatMap((notes, at) =>
        (notes ?? []).map((n) => ({ at, freqs: n.freqs, drums: n.drums.map((d) => DRUM_NAMES.indexOf(d)), steps: n.steps })),
      ),
    })),
  };
}

let panes = 0;
/** The first message of this page also clears panes a previous page left playing */
let fresh = true;

/**
 * A pane's game sound. Ascy synthesizes and plays it natively: WebKitGTK's
 * Web Audio stalls and stutters on Bluetooth headphones. Here what games ask
 * for is checked (sound.ts) and passed on, batched once per task. One per
 * arcade pane; nothing plays while the pane is hidden or muted.
 */
export class ArcadeAudio {
  private readonly pane = `arcade-${++panes}`;
  private ops: Op[] = [];
  private hidden = false;

  constructor(private volume: number) {
    this.volume = num(volume, 0.6, 0, 1);
    this.send({ op: "volume", volume: this.volume });
  }

  /** 0 mutes */
  setVolume(volume: number) {
    this.volume = num(volume, 0.6, 0, 1);
    this.send({ op: "volume", volume: this.volume });
  }

  /** The pane went off screen (or came back): everything pauses */
  setHidden(hidden: boolean) {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.send({ op: "hidden", hidden });
  }

  /** A sound effect: a preset name, a layer or layers (sound.ts); opts: volume, pan, rate */
  play(spec: unknown, opts: unknown) {
    if (this.volume <= 0 || this.hidden) return;
    let tones: Tone[];
    try {
      tones = toTones(spec);
    } catch {
      return; // games can check their sounds with the tools in docs/games.md
    }
    const o = (opts && typeof opts === "object" ? opts : {}) as Record<string, unknown>;
    this.send({ op: "sound", tones, volume: num(o.volume, 1, 0, 1), pan: num(o.pan, 0, -1, 1), rate: num(o.rate, 1, 0.25, 4) });
  }

  /** Starts a song (replacing the one playing); null stops the music */
  music(spec: unknown) {
    let song: Song | null = null;
    if (spec !== null && spec !== undefined) {
      try {
        song = toSong(spec);
      } catch {
        // a broken song stops the music, as the old one is replaced either way
      }
    }
    this.send({ op: "music", song: song && wire(song) });
  }

  /** The game ended: everything fades out */
  stop() {
    this.send({ op: "stop" });
  }

  dispose() {
    this.send({ op: "close" });
  }

  private send(op: Op) {
    if (!this.ops.length) queueMicrotask(() => this.flush());
    this.ops.push(op);
  }

  private flush() {
    const ops = this.ops;
    this.ops = [];
    if (fresh) ops.unshift({ op: "reset" });
    fresh = false;
    invoke("arcade_audio", { pane: this.pane, ops }).catch(() => {});
  }
}
