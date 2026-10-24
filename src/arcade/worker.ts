/**
 * Everything here runs inside a game's Web Worker. The host turns these
 * functions into source text (fn.toString()) and puts it into a blob worker
 * in front of the game's own code, so they must be self-contained: no
 * imports and no references to anything outside their own body.
 */


/** Returns the Screen class: the grid of character cells a game draws on */
export function screenClass() {
  // ANSI order, so palette color i becomes SGR 30+i / 90+i in the terminal
  const PALETTE = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "gray", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
  ];
  const STYLES: Record<string, number> = { bold: 1, dim: 2, italic: 4, underline: 8, reverse: 16 };
  // Ranges of characters that take two cells (CJK, Hangul, fullwidth forms)
  const WIDE = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
    [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
    [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
  ];
  // Colorful emoji are pictures, not text, so they show as "?"
  const EMOJI = /\p{Emoji_Presentation}/u;
  const MARK = /\p{M}/u;
  const cache = new Map<unknown, number>();

  /** Color → cell value: 0 default, 1+n palette/256-color n, 0x1000000|rgb truecolor */
  function color(c: unknown): number {
    if (c === undefined || c === null || c === "default") return 0;
    let v = cache.get(c);
    if (v !== undefined) return v;
    v = 0;
    if (typeof c === "number") {
      if (c >= 0 && c <= 255) v = 1 + Math.floor(c);
    } else if (typeof c === "string") {
      const i = PALETTE.indexOf(c === "grey" || c === "brightBlack" ? "gray" : c);
      if (i >= 0) v = 1 + i;
      else {
        const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
        if (m) v = 0x1000000 | parseInt(m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1], 16);
      }
    }
    cache.set(c, v);
    return v;
  }

  function style(s: unknown): number {
    if (!s) return 0;
    let bits = 0;
    for (const word of String(s).split(/\s+/)) bits |= STYLES[word] ?? 0;
    return bits;
  }

  function width(cp: number): number {
    if (cp < 0x1100) return 1;
    for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
    return 1;
  }

  /** Characters with no cell of their own: combining marks, joiners, variation selectors */
  function invisible(ch: string, cp: number): boolean {
    return cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f || (cp >= 0x300 && MARK.test(ch));
  }

  function textWidth(str: string): number {
    let w = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0)!;
      if (!invisible(ch, cp)) w += width(cp);
    }
    return w;
  }

  return class Screen {
    width = 0;
    height = 0;
    ch = new Uint32Array(0);
    fg = new Uint32Array(0);
    bg = new Uint32Array(0);
    at = new Uint8Array(0);

    constructor(width: number, height: number) {
      this.resize(width, height);
    }

    resize(width: number, height: number) {
      this.width = Math.max(0, Math.floor(width));
      this.height = Math.max(0, Math.floor(height));
      const n = this.width * this.height;
      this.ch = new Uint32Array(n);
      this.fg = new Uint32Array(n);
      this.bg = new Uint32Array(n);
      this.at = new Uint8Array(n);
      this.clear();
    }

    /** Blanks the whole screen, optionally with a background color */
    clear(bg?: unknown) {
      this.ch.fill(32);
      this.fg.fill(0);
      this.bg.fill(color(bg));
      this.at.fill(0);
    }

    /** One character at (x, y); returns the cells it takes (1, or 2 for wide ones) */
    put(x: number, y: number, char: unknown, fg?: unknown, bg?: unknown, st?: unknown): number {
      const cp = String(char ?? " ").codePointAt(0) ?? 32;
      return this._cell(Math.floor(x), Math.floor(y), cp, color(fg), color(bg), style(st));
    }

    /** A string from (x, y) ("\n" starts a new line); returns the x after it */
    text(x: number, y: number, str: unknown, fg?: unknown, bg?: unknown, st?: unknown): number {
      const f = color(fg);
      const b = color(bg);
      const a = style(st);
      const left = Math.floor(x);
      x = left;
      y = Math.floor(y);
      for (const ch of String(str)) {
        const cp = ch.codePointAt(0)!;
        if (cp === 10) {
          y++;
          x = left;
        } else if (!invisible(ch, cp)) {
          x += this._cell(x, y, cp, f, b, a);
        }
      }
      return x;
    }

    /** Text centered horizontally on row y (every line of it) */
    center(y: number, str: unknown, fg?: unknown, bg?: unknown, st?: unknown) {
      String(str)
        .split("\n")
        .forEach((line, i) => {
          this.text(Math.floor((this.width - textWidth(line)) / 2), y + i, line, fg, bg, st);
        });
    }

    /** Fills a rectangle with one character */
    fill(x: number, y: number, w: number, h: number, char: unknown, fg?: unknown, bg?: unknown, st?: unknown) {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; ) i += this.put(x + i, y + j, char, fg, bg, st) || 1;
      }
    }

    /** A rounded border; the inside is left as it is */
    box(x: number, y: number, w: number, h: number, fg?: unknown, bg?: unknown, st?: unknown) {
      if (w < 2 || h < 2) return;
      const r = x + w - 1;
      const b = y + h - 1;
      for (let i = x + 1; i < r; i++) {
        this.put(i, y, "─", fg, bg, st);
        this.put(i, b, "─", fg, bg, st);
      }
      for (let j = y + 1; j < b; j++) {
        this.put(x, j, "│", fg, bg, st);
        this.put(r, j, "│", fg, bg, st);
      }
      this.put(x, y, "╭", fg, bg, st);
      this.put(r, y, "╮", fg, bg, st);
      this.put(x, b, "╰", fg, bg, st);
      this.put(r, b, "╯", fg, bg, st);
    }

    _cell(x: number, y: number, cp: number, f: number, b: number, a: number): number {
      if (cp >= 0x231a && EMOJI.test(String.fromCodePoint(cp))) cp = 63; // "?"
      if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) cp = 32; // no control characters
      const w = width(cp);
      if (y < 0 || y >= this.height || x < 0 || x + w > this.width) return w;
      const i = y * this.width + x;
      const { ch } = this;
      // Overwriting half of a wide character blanks the other half
      if (ch[i] === 0 && x > 0) ch[i - 1] = 32;
      if (x + w < this.width && ch[i + w] === 0) ch[i + w] = 32;
      for (let k = 0; k < w; k++) {
        ch[i + k] = k === 0 ? cp : 0; // 0 marks the second half of a wide character
        this.fg[i + k] = f;
        this.bg[i + k] = b;
        this.at[i + k] = a;
      }
      return w;
    }
  };
}

/** The game loop inside the worker: talks to the host and calls the game's callbacks */
export function workerMain(Screen: any) {
  const post = (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    (self as any).postMessage(msg, transfer);

  let game: Record<string, any> | null = null;
  const state: Record<string, unknown> = {};
  let screen: any = null;
  let storage: Record<string, unknown> = {};
  const held = new Set<string>();
  const pressed = new Set<string>();
  const released = new Set<string>();
  let typed = "";
  const mouse = { x: -1, y: -1, down: false, pressed: false, released: false, button: 0, wheel: 0 };

  const input = {
    /** The key is down right now */
    held: (key: string) => held.has(key),
    /** The key went down since the last frame (key repeat doesn't count) */
    pressed: (key: string) => pressed.has(key),
    /** The key went up since the last frame */
    released: (key: string) => released.has(key),
    /** Text typed since the last frame */
    get typed() {
      return typed;
    },
    mouse,
  };

  const ascy: Record<string, unknown> = {
    api: 2,
    best: null,
    system: null,
    game(callbacks: Record<string, any>) {
      game = callbacks;
    },
    storage: {
      get: (key: string) => storage[key],
      set(key: string, value: unknown) {
        storage[key] = value;
        post({ t: "save", data: storage });
      },
    },
    score(value: number) {
      post({ t: "score", value });
    },
    exit() {
      post({ t: "exit" });
    },
    /** A sound effect, played by Ascy (a worker has no audio) */
    sound(sound: unknown, opts?: unknown) {
      post({ t: "sound", sound, opts });
    },
    /** Starts a song, or stops the music with null */
    music(song: unknown) {
      post({ t: "music", song: song ?? null });
    },
  };
  (self as any).ascy = ascy;

  function apply(e: Record<string, any>) {
    switch (e.k) {
      case "down":
        if (!e.repeat) {
          held.add(e.key);
          pressed.add(e.key);
        }
        if (e.text) typed += e.text;
        break;
      case "up":
        held.delete(e.key);
        released.add(e.key);
        break;
      case "blur":
        held.clear();
        mouse.down = false;
        break;
      case "mouse":
        mouse.x = e.x;
        mouse.y = e.y;
        if (e.type === "down") {
          mouse.down = true;
          mouse.pressed = true;
          mouse.button = e.button;
        } else if (e.type === "up") {
          mouse.down = false;
          mouse.released = true;
        } else if (e.type === "wheel") {
          mouse.wheel += e.delta;
        }
        break;
    }
  }

  function frame(dt: number) {
    game!.update?.(state, input, dt);
    game!.draw?.(state, screen);
    pressed.clear();
    released.clear();
    typed = "";
    mouse.pressed = false;
    mouse.released = false;
    mouse.wheel = 0;
    const out = {
      t: "frame",
      width: screen.width,
      height: screen.height,
      ch: screen.ch.slice(),
      fg: screen.fg.slice(),
      bg: screen.bg.slice(),
      at: screen.at.slice(),
    };
    post(out, [out.ch.buffer, out.fg.buffer, out.bg.buffer, out.at.buffer]);
  }

  /** Extra API for the game list only: the games and a few host actions */
  function system(info: Record<string, unknown>) {
    return {
      ...info,
      launch: (id: string, selected: number) => post({ t: "launch", id, selected }),
      openFolder: () => post({ t: "open-folder" }),
      openGuide: () => post({ t: "open-guide" }),
      reload: () => post({ t: "reload" }),
    };
  }

  (self as any).onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    try {
      if (m.t === "start") {
        if (!game) throw new Error("the game never called ascy.game({ ... })");
        storage = m.storage ?? {};
        ascy.best = m.best ?? null;
        if (m.system) ascy.system = system(m.system);
        screen = new Screen(m.width, m.height);
        game.init?.(state, { width: m.width, height: m.height });
      } else if (m.t === "resize") {
        screen.resize(m.width, m.height);
        game!.resize?.(state, { width: m.width, height: m.height });
      } else if (m.t === "frame") {
        for (const e of m.events) apply(e);
        frame(m.dt);
      } else if (m.t === "best") {
        ascy.best = m.value;
      }
    } catch (err: any) {
      post({ t: "error", message: String(err?.message ?? err), stack: String(err?.stack ?? "") });
    }
  };
}
