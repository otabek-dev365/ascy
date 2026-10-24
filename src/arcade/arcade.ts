import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Terminal } from "@xterm/xterm";
import { ArcadeAudio } from "./audio";
import { GridRenderer, isFrame } from "./render";
import { screenClass, workerMain } from "./worker";
import hubSource from "./hub.js?raw";
import snakeSource from "./games/snake/main.js?raw";
import snakeManifest from "./games/snake/game.json";

/** The game API this Ascy provides ("api" in game.json); 2 added sound and music */
const API_VERSION = 2;
/** Sound effects a game may start per frame */
const SOUNDS_PER_FRAME = 24;
const GUIDE_URL = "https://github.com/otabek-dev365/ascy/blob/main/docs/games.md";
/** A game that sends no frame for this long is stopped */
const WATCHDOG_MS = 5000;

/** game.json — every field is optional and checked before use */
interface Manifest {
  api?: unknown;
  name?: unknown;
  author?: unknown;
  version?: unknown;
  description?: unknown;
  controls?: unknown;
  cover?: unknown;
  color?: unknown;
  score?: unknown;
}

interface Game {
  id: string;
  manifest: Manifest;
  /** Why the game can't be played (broken game.json, bad folder name) */
  error: string | null;
  /** Built-in games ship their code; installed ones are read from disk */
  source?: string;
}

/** What a game keeps between runs */
interface GameData {
  best?: number;
  storage?: Record<string, unknown>;
}

const BUILT_IN: Game[] = [
  { id: "ascy.snake", manifest: snakeManifest, error: null, source: snakeSource },
];

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** KeyboardEvent.code → the key name games use: "a", "1", "up", "space", "shift", "f5", … */
function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5).toLowerCase();
  const mod = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  if (mod) return { Shift: "shift", Control: "ctrl", Alt: "alt", Meta: "meta" }[mod[1]]!;
  return code.toLowerCase();
}

/** The game's own line number in a worker stack trace, if there is one */
function lineOf(stack: string, offset: number): number | undefined {
  for (const m of stack.matchAll(/:(\d+):\d+\)?$/gm)) {
    const line = Number(m[1]) - offset;
    if (line > 0) return line;
  }
  return undefined;
}

export interface ArcadeHooks {
  /** Pane title: "Arcade", "Arcade · Snake" */
  setTitle(title: string): void;
  /** Esc in the game list: back to the tab the arcade was opened from */
  leave(): void;
  /** The theme's accent color, for the game list */
  accent(): string;
  toast(text: string, isError?: boolean): void;
}

/**
 * Runs the game list and the games in one pane. Each runs in its own Web
 * Worker — no access to files, the network or the app — and sends frames of
 * character cells that are drawn into the pane's terminal.
 */
export class Arcade {
  private worker: Worker | null = null;
  private workerUrl = "";
  /** Lines in front of the game's code in the worker, to report the game's own line numbers */
  private lineOffset = 0;
  private readonly renderer: GridRenderer;
  private events: Record<string, unknown>[] = [];
  /** A frame was requested and hasn't come back yet */
  private waiting = false;
  /** The terminal is still taking in the last frame */
  private drawing = false;
  private sentAt = 0;
  private lastTick = 0;
  private raf = 0;
  private visible = false;
  /** The game being played; null while the game list is shown */
  private current: Game | null = null;
  private games: Game[] = [];
  private data: GameData = {};
  private saveTimer = 0;
  private hubSelected = 0;
  /** An error screen is shown instead of a game */
  private crashed = false;
  /** Bumped by every switch, so a slow load can't start an outdated game */
  private generation = 0;
  private lastMouse = { x: -1, y: -1 };
  private readonly audio: ArcadeAudio;
  private sounds = 0;
  private readonly onVisibility = () => this.updateLoop();

  constructor(
    private readonly term: Terminal,
    private readonly hooks: ArcadeHooks,
    volume: number,
  ) {
    this.renderer = new GridRenderer(term);
    this.audio = new ArcadeAudio(volume);
    // No cursor and no line wrapping: the screen is a grid of cells
    term.write("\x1b[?25l\x1b[?7l");
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Shows the game list, reading the games folder again */
  async showHub() {
    const gen = ++this.generation;
    this.flushSave();
    // Stop the game first: its messages must never be taken for the game list's
    this.stopWorker();
    this.current = null;
    this.hooks.setTitle("Arcade");
    const installed = await invoke<{ id: string; manifest: Manifest | null; error: string | null }[]>(
      "games_list",
    ).catch(() => []);
    const games: Game[] = [
      ...BUILT_IN,
      ...installed.map((g) => ({ id: g.id, manifest: g.manifest ?? {}, error: g.error })),
    ];
    const saved = await Promise.all(games.map((g) => this.loadData(g.id)));
    if (gen !== this.generation) return;
    this.games = games;
    const list = games.map((g, i) => ({
      id: g.id,
      name: this.name(g),
      author: text(g.manifest.author, 40),
      version: text(g.manifest.version, 20),
      description: text(g.manifest.description, 300),
      controls: text(g.manifest.controls, 200),
      cover: Array.isArray(g.manifest.cover) ? g.manifest.cover.slice(0, 4).map((l) => text(l, 40)) : [],
      color: text(g.manifest.color, 20),
      best: typeof saved[i].best === "number" ? saved[i].best : null,
      builtIn: g.source !== undefined,
      error: g.error ?? this.apiError(g),
    }));
    this.run(hubSource, {
      system: { games: list, selected: this.hubSelected, accent: this.hooks.accent() },
    });
  }

  async launch(id: string) {
    const game = this.games.find((g) => g.id === id);
    if (!game) return;
    const gen = ++this.generation;
    this.flushSave();
    this.stopWorker();
    this.current = game;
    this.hooks.setTitle(`Arcade · ${this.name(game)}`);
    const problem = game.error ?? this.apiError(game);
    if (problem) return this.fail(problem);
    let source = game.source;
    if (source === undefined) {
      try {
        source = await invoke<string>("game_source", { id });
      } catch (e) {
        if (gen === this.generation) this.fail(String(e));
        return;
      }
    }
    const data = await this.loadData(id);
    if (gen !== this.generation) return;
    this.data = data;
    this.run(source, { storage: data.storage ?? {}, best: data.best ?? null });
  }

  /** Re-reads the game list (after a game was installed) unless a game is running */
  refresh() {
    if (!this.current && !this.crashed) this.showHub();
  }

  /** Games run only while their pane is on screen */
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.blur();
    this.updateLoop();
  }

  /** Game sound volume, 0 (off) … 1 */
  setVolume(volume: number) {
    this.audio.setVolume(volume);
  }

  key(e: KeyboardEvent) {
    if (e.type !== "keydown" && e.type !== "keyup") return;
    if (this.crashed) {
      if (e.type === "keydown" && e.code === "Escape") {
        if (this.current) this.showHub();
        else this.hooks.leave();
      }
      return;
    }
    const key = keyName(e.code);
    if (e.type === "keydown") {
      this.push({ k: "down", key, repeat: e.repeat, text: e.key.length === 1 ? e.key : "" });
    } else {
      this.push({ k: "up", key });
    }
  }

  mouse(e: PointerEvent | WheelEvent) {
    if (!this.worker) return;
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const r = screen.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.term.cols);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.term.rows);
    const type =
      e.type === "wheel" ? "wheel"
      : e.type === "pointerdown" ? "down"
      : e.type === "pointerup" ? "up"
      : "move";
    if (type === "move" && x === this.lastMouse.x && y === this.lastMouse.y) return;
    this.lastMouse = { x, y };
    const delta = e instanceof WheelEvent ? Math.sign(e.deltaY) : 0;
    this.push({ k: "mouse", type, x, y, button: e.button, delta });
  }

  /** Focus left the pane: no key is held any more */
  blur() {
    this.push({ k: "blur" });
  }

  resize(cols: number, rows: number) {
    this.renderer.reset();
    this.worker?.postMessage({ t: "resize", width: cols, height: rows });
  }

  dispose() {
    this.flushSave();
    this.stopWorker();
    this.audio.dispose();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  // ---------- worker ----------

  /** Starts code in a fresh worker: the runtime first, then the game's code */
  private run(source: string, init: Record<string, unknown>) {
    this.stopWorker();
    this.crashed = false;
    const prefix =
      `"use strict";\nconst Screen = (${screenClass.toString()})();\n` +
      `(${workerMain.toString()})(Screen);\n`;
    this.lineOffset = prefix.split("\n").length - 1;
    this.workerUrl = URL.createObjectURL(new Blob([prefix, source, "\n"], { type: "text/javascript" }));
    const worker = new Worker(this.workerUrl);
    this.worker = worker;
    worker.onmessage = (e) => {
      if (worker === this.worker) this.onMessage(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      if (worker !== this.worker) return;
      const line = e.lineno ? e.lineno - this.lineOffset : undefined;
      this.fail(e.message || "the game's code couldn't run", line && line > 0 ? line : undefined);
    };
    this.events = [];
    this.renderer.reset();
    this.term.write("\x1b[0m\x1b[2J");
    worker.postMessage({ t: "start", width: this.term.cols, height: this.term.rows, ...init });
    this.updateLoop();
  }

  private stopWorker() {
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = "";
    this.waiting = false;
    this.drawing = false;
    this.audio.stop();
    this.updateLoop();
  }

  /** The frame loop runs only while a worker is up and the pane is on screen */
  private updateLoop() {
    this.audio.setHidden(!this.visible || document.hidden);
    const run = !!this.worker && this.visible && !document.hidden;
    if (run && !this.raf) {
      this.lastTick = 0;
      this.sentAt = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    } else if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (!this.worker) return;
    if (this.waiting) {
      if (now - this.sentAt > WATCHDOG_MS) this.fail("it stopped responding (no frame for 5 seconds)");
      return;
    }
    // A game that draws a lot must not get ahead of the terminal: frames
    // would pile up in its write queue and the controls would lag behind
    if (this.drawing) return;
    const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    this.sounds = 0;
    this.waiting = true;
    this.sentAt = now;
    this.worker.postMessage({ t: "frame", dt, events: this.events.splice(0) });
  };

  private push(event: Record<string, unknown>) {
    this.events.push(event);
    if (this.events.length > 256) this.events.shift();
  }

  private onMessage(m: Record<string, unknown>) {
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "frame":
        this.waiting = false;
        if (isFrame(m, this.term.cols, this.term.rows)) {
          this.drawing = true;
          this.renderer.draw(m, () => (this.drawing = false));
        }
        break;
      case "sound":
        if (++this.sounds <= SOUNDS_PER_FRAME) this.audio.play(m.sound, m.opts);
        break;
      case "music":
        this.audio.music(m.song);
        break;
      case "save":
        if (this.current && m.data && typeof m.data === "object") {
          this.data.storage = m.data as Record<string, unknown>;
          this.scheduleSave();
        }
        break;
      case "score":
        if (this.current) this.score(m.value);
        break;
      case "exit":
        if (this.current) this.showHub();
        else this.hooks.leave();
        break;
      case "error":
        this.fail(String(m.message), lineOf(String(m.stack), this.lineOffset));
        break;
      // The rest is for the game list only
      case "launch":
        if (!this.current && typeof m.id === "string") {
          this.hubSelected = Number(m.selected) || 0;
          this.launch(m.id);
        }
        break;
      case "open-folder":
        if (!this.current) invoke("games_open_folder").catch((e) => this.hooks.toast(String(e), true));
        break;
      case "open-guide":
        if (!this.current) openUrl(GUIDE_URL).catch(() => {});
        break;
      case "reload":
        if (!this.current) this.showHub();
        break;
    }
  }

  /** Stops the worker and shows what went wrong; Esc goes back */
  private fail(message: string, line?: number) {
    this.stopWorker();
    this.crashed = true;
    // Text from a game never reaches the terminal with control characters in it
    const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const who = this.current ? this.name(this.current) : "The game list";
    const detail = clean(message + (line ? ` (line ${line})` : ""));
    const width = Math.max(20, this.term.cols - 6);
    let out = `\x1b[0m\x1b[2J\x1b[2;4H\x1b[1;31m${clean(who)} stopped with an error\x1b[0m`;
    let row = 4;
    for (let i = 0; i < detail.length && row < this.term.rows - 2; i += width) {
      out += `\x1b[${row++};4H${detail.slice(i, i + width)}`;
    }
    out += `\x1b[${row + 1};4H\x1b[2mEsc — back\x1b[0m`;
    this.renderer.reset();
    this.term.write(out);
  }

  // ---------- saved data ----------

  private loadData(id: string): Promise<GameData> {
    return invoke<GameData | null>("game_data_load", { id })
      .then((d) => (d && typeof d === "object" ? d : {}))
      .catch(() => ({}));
  }

  private score(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const lower = this.current!.manifest.score === "lower";
    // With "higher is better", a round that scored nothing isn't a best
    if (!lower && value <= 0) return;
    const best = this.data.best;
    if (best === undefined || (lower ? value < best : value > best)) {
      this.data.best = value;
      this.worker?.postMessage({ t: "best", value });
      this.scheduleSave(); // not right away: a game may report a new best every frame
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.writeData(), 500);
  }

  /** Writes data that is waiting to be saved (before switching games, on close) */
  private flushSave() {
    if (this.saveTimer) this.writeData();
  }

  private writeData() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    const game = this.current;
    if (!game) return;
    invoke("game_data_save", { id: game.id, data: this.data }).catch((e) =>
      this.hooks.toast(`${this.name(game)}: couldn't save (${e})`, true),
    );
  }

  private name(game: Game): string {
    return text(game.manifest.name, 40) || game.id;
  }

  private apiError(game: Game): string | null {
    const api = game.manifest.api;
    return typeof api === "number" && api > API_VERSION
      ? `This game needs a newer Ascy (game API ${api}, this one has ${API_VERSION})`
      : null;
  }
}
