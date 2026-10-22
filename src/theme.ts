import type { ITheme } from "@xterm/xterm";

export interface AppTheme {
  xterm: ITheme;
  /** Background in normal mode */
  bgOpaque: string;
  /** Semi-transparent background so the matrix animation shows through */
  bgTransparent: string;
  /** Tab bar and general UI colors (CSS variables) */
  css: Record<string, string>;
}

// Tokyo Night style — dark blue-black background, soft white text, blue directories
const night: AppTheme = {
  bgOpaque: "#16161e",
  bgTransparent: "#16161eb0",
  xterm: {
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: "#16161e",
    selectionBackground: "#33467c",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#ff899d",
    brightGreen: "#9fe044",
    brightYellow: "#faba4a",
    brightBlue: "#8db0ff",
    brightMagenta: "#c7a9ff",
    brightCyan: "#a4daff",
    brightWhite: "#c0caf5",
  },
  css: {
    "--bg": "#16161e",
    "--fg": "#c0caf5",
    "--border": "#292e42",
    "--tab-bg": "#101014",
    "--tab-active": "#292e42",
    "--accent": "#7aa2f7",
  },
};

const hacker: AppTheme = {
  bgOpaque: "#000000",
  bgTransparent: "#000000a0",
  xterm: {
    foreground: "#00ff41",
    cursor: "#00ff41",
    cursorAccent: "#000000",
    selectionBackground: "#00ff4140",
    black: "#0c1a0c",
    red: "#ff5f56",
    green: "#00ff41",
    yellow: "#b8ff5c",
    blue: "#2ec7a6",
    magenta: "#4affab",
    cyan: "#39ffd5",
    white: "#ace2ac",
    brightBlack: "#1f4d1f",
    brightRed: "#ff7b72",
    brightGreen: "#5cff7d",
    brightYellow: "#d2ff7e",
    brightBlue: "#55e6c0",
    brightMagenta: "#8affc9",
    brightCyan: "#7dffe0",
    brightWhite: "#d9ffd9",
  },
  css: {
    "--bg": "#000000",
    "--fg": "#00ff41",
    "--border": "#003b13",
    "--tab-bg": "#020a02",
    "--tab-active": "#04220c",
    "--accent": "#00ff41",
  },
};

const BUILT_IN: Record<string, AppTheme> = { hacker, night };

/** A user theme from settings.json: xterm colors on top of a built-in theme */
export interface ThemeSpec extends ITheme {
  /** Built-in theme to start from (default: the one with the same name, else night) */
  base?: string;
  /** Active tab, focused pane border and sliders */
  accent?: string;
}

/** Mixes two #rgb/#rrggbb colors; null if either can't be parsed */
function mix(a: string, b: string, t: number): string | null {
  const rgb = (c: string) => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
    if (!m) return null;
    const hex = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join("") : m[1];
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  };
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

function buildTheme(name: string, spec: ThemeSpec): AppTheme {
  const { base: baseName, accent, background, ...colors } = spec;
  const base = BUILT_IN[baseName ?? name] ?? night;
  const bg = background ?? base.bgOpaque;
  const fg = colors.foreground ?? base.css["--fg"];
  // UI colors follow the new background/foreground; untouched ones stay as in the base
  const recolored = background !== undefined || colors.foreground !== undefined;
  const derive = (key: string, value: string | null) =>
    (recolored && value) || base.css[key];
  return {
    xterm: { ...base.xterm, ...colors },
    bgOpaque: bg,
    bgTransparent: /^#[0-9a-f]{6}$/i.test(bg) ? `${bg}b0` : bg,
    css: {
      "--bg": bg,
      "--fg": fg,
      "--accent": accent ?? base.css["--accent"],
      "--border": derive("--border", mix(bg, fg, 0.15)),
      "--tab-bg": derive("--tab-bg", mix(bg, "#000000", 0.3)),
      "--tab-active": derive("--tab-active", mix(bg, fg, 0.12)),
    },
  };
}

export interface ThemeRegistry {
  themes: Record<string, AppTheme>;
  /** Problems in the user's themes, worth showing */
  errors: string[];
}

/** The built-in themes plus the user's "themes" from settings.json */
export function resolveThemes(user: unknown): ThemeRegistry {
  const themes: Record<string, AppTheme> = { ...BUILT_IN };
  const errors: string[] = [];
  if (user && typeof user === "object") {
    for (const [name, spec] of Object.entries(user)) {
      if (spec && typeof spec === "object") themes[name] = buildTheme(name, spec as ThemeSpec);
      else errors.push(`theme "${name}" must be an object of colors`);
    }
  }
  return { themes, errors };
}

/** "mocha" — alias for old settings files (replaced by night) */
export function themeByName(registry: ThemeRegistry, name: string): AppTheme | undefined {
  return registry.themes[name === "mocha" && !registry.themes.mocha ? "night" : name];
}
