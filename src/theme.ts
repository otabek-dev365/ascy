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

// "mocha" — alias for old settings files (replaced by night)
export const themes: Record<string, AppTheme> = { night, hacker, mocha: night };

export function getTheme(name: string): AppTheme {
  return themes[name] ?? hacker;
}
