import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  fontFamily: string;
  fontSize: number;
  theme: "night" | "hacker";
  matrix: boolean;
  /** Matrix ustidagi qoraytirish darajasi: 0 (parda yo'q) .. 0.9 (deyarli qora) */
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
    // Birinchi ishga tushirishda faylni yaratamiz — foydalanuvchi Ctrl+, bilan ochib tahrirlaydi
    await saveSettings(DEFAULT_SETTINGS).catch(() => {});
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...saved } as Settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("settings_save", { settings });
}
