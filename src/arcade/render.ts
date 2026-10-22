import type { Terminal } from "@xterm/xterm";

/** One frame from a game: the cells of its screen, row by row */
export interface Frame {
  width: number;
  height: number;
  /** Code points; 0 = the second half of a wide character */
  ch: Uint32Array;
  /** 0 default, 1+n palette/256-color n, 0x1000000|rgb truecolor */
  fg: Uint32Array;
  bg: Uint32Array;
  /** Style bits: 1 bold, 2 dim, 4 italic, 8 underline, 16 reverse */
  at: Uint8Array;
}

/** Frames come from untrusted game code: check the shape before using one */
export function isFrame(m: unknown, width: number, height: number): m is Frame {
  const f = m as Frame;
  const n = width * height;
  return (
    f.width === width &&
    f.height === height &&
    f.ch instanceof Uint32Array && f.ch.length === n &&
    f.fg instanceof Uint32Array && f.fg.length === n &&
    f.bg instanceof Uint32Array && f.bg.length === n &&
    f.at instanceof Uint8Array && f.at.length === n
  );
}

/**
 * Only printable characters reach the terminal: a control character could
 * start an escape sequence (clipboard, links, terminal modes, …)
 */
function printable(cp: number): number {
  const control = cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
  const invalid = (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff;
  return control || invalid ? 0x20 : cp;
}

/** Characters every terminal draws one cell wide, so the cursor position stays known */
function narrow(cp: number): boolean {
  return (
    cp < 0x7f ||
    (cp >= 0xa0 && cp < 0x1100) ||
    (cp >= 0x2190 && cp < 0x2200) || // arrows
    (cp >= 0x2500 && cp < 0x2600) || // box drawing, blocks, shapes
    (cp >= 0x2800 && cp < 0x2900) // braille
  );
}

function sgrColor(c: number, base: number): string {
  if (c === 0) return "";
  if (c & 0x1000000) return `;${base + 8};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`;
  const n = c - 1;
  if (n < 8) return `;${base + n}`;
  if (n < 16) return `;${base + 60 + n - 8}`;
  return `;${base + 8};5;${n}`;
}

function sgr(fg: number, bg: number, at: number): string {
  let s = "\x1b[0";
  if (at & 1) s += ";1";
  if (at & 2) s += ";2";
  if (at & 4) s += ";3";
  if (at & 8) s += ";4";
  if (at & 16) s += ";7";
  return s + sgrColor(fg, 30) + sgrColor(bg, 40) + "m";
}

/**
 * Draws frames into an xterm.js terminal. Only cells that changed since the
 * last frame are written, inside a synchronized update (no half-drawn frames).
 */
export class GridRenderer {
  private prev: Frame | null = null;

  constructor(private term: Pick<Terminal, "write">) {}

  /** Forget the last frame: the next one is drawn in full */
  reset() {
    this.prev = null;
  }

  draw(f: Frame) {
    const { width: w, height: h } = f;
    const prev = this.prev?.width === w && this.prev.height === h ? this.prev : null;
    let out = "\x1b[?2026h";
    if (!prev) out += "\x1b[0m\x1b[2J";
    let pen = { fg: -1, bg: -1, at: -1 };
    let cx = -1;
    let cy = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const cp = f.ch[i];
        if (cp === 0) continue; // drawn together with the wide character before it
        const wide = x + 1 < w && f.ch[i + 1] === 0;
        if (
          prev &&
          cp === prev.ch[i] &&
          f.fg[i] === prev.fg[i] &&
          f.bg[i] === prev.bg[i] &&
          f.at[i] === prev.at[i] &&
          wide === (x + 1 < w && prev.ch[i + 1] === 0)
        ) {
          continue;
        }
        if (cx !== x || cy !== y) out += `\x1b[${y + 1};${x + 1}H`;
        if (f.fg[i] !== pen.fg || f.bg[i] !== pen.bg || f.at[i] !== pen.at) {
          pen = { fg: f.fg[i], bg: f.bg[i], at: f.at[i] };
          out += sgr(pen.fg, pen.bg, pen.at);
        }
        const c = printable(cp);
        out += String.fromCodePoint(c);
        // After a character of unsure width the next one gets an explicit position
        cy = y;
        cx = wide ? x + 2 : narrow(c) ? x + 1 : -1;
      }
    }
    out += "\x1b[0m\x1b[?2026l";
    this.term.write(out);
    this.prev = f;
  }
}
