import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  fontFamily: string;
  fontSize: number;
  theme: "night" | "hacker";
  matrix: boolean;
  /** How much the matrix rain is dimmed: 0 (no shade) .. 0.9 (almost black) */
  shade: number;
  scrollback: number;
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily:
    '"JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "Ubuntu Mono", "DejaVu Sans Mono", monospace',
  fontSize: 14,
  theme: "hacker",
  matrix: true,
  shade: 0.28,
  scrollback: 10000,
};

export async function loadSettings(): Promise<Settings> {
  const saved = await invoke<Record<string, unknown> | null>(
    "settings_load",
  ).catch(() => null);
  if (!saved) {
    // Create the file on first run so the user can open it with Ctrl+, and edit it
    await saveSettings(DEFAULT_SETTINGS).catch(() => {});
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...saved } as Settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("settings_save", { settings });
}
