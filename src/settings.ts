import { invoke } from "@tauri-apps/api/core";
import type { ThemeSpec } from "./theme";

export interface Settings {
  fontFamily: string;
  fontSize: number;
  /** "hacker", "night" or the name of a theme in `themes` */
  theme: string;
  matrix: boolean;
  /** How much the matrix rain is dimmed: 0 (no shade) .. 0.9 (almost black) */
  shade: number;
  scrollback: number;
  /** Key combo → action, on top of the defaults; null removes a binding */
  keybindings: Record<string, string | null>;
  /** User themes: name → xterm colors (see ThemeSpec) */
  themes: Record<string, ThemeSpec>;
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily:
    '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "Ubuntu Mono", "DejaVu Sans Mono", monospace',
  fontSize: 14,
  theme: "hacker",
  matrix: true,
  shade: 0.28,
  scrollback: 10000,
  keybindings: {},
  themes: {},
};

export interface LoadResult {
  /** null when settings.json exists but can't be parsed */
  settings: Settings | null;
  /** A problem worth showing to the user */
  error?: string;
}

/** While settings.json is broken we never write to it — that would wipe the user's edits */
let fileBroken = false;

export async function loadSettings(): Promise<LoadResult> {
  let saved: Record<string, unknown> | null;
  try {
    saved = await invoke("settings_load");
  } catch (e) {
    fileBroken = true;
    return {
      settings: null,
      error: `settings.json is invalid (${e}).\nChanges won't be saved until it's fixed.`,
    };
  }
  fileBroken = false;
  if (!saved) {
    // Create the file on first run so the user can open it with Ctrl+, and edit it
    await saveSettings(DEFAULT_SETTINGS).catch(() => {});
    return { settings: { ...DEFAULT_SETTINGS } };
  }
  const settings = { ...DEFAULT_SETTINGS, ...saved } as Settings;
  // A value of the wrong type (e.g. "fontSize": "14") falls back to the default
  const wrong = (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).filter(
    (k) => typeof settings[k] !== typeof DEFAULT_SETTINGS[k],
  );
  for (const k of wrong) Object.assign(settings, { [k]: DEFAULT_SETTINGS[k] });
  return {
    settings,
    error: wrong.length
      ? `settings.json: invalid ${wrong.join(", ")} — using the default`
      : undefined,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (fileBroken) return;
  await invoke("settings_save", { settings });
}
