/** Everything a key binding can trigger (the names used in settings.json) */
const BASE_ACTIONS = [
  "new-tab",
  "close-pane",
  "next-tab",
  "prev-tab",
  "rename-tab",
  "split-right",
  "split-down",
  "toggle-zoom",
  "focus-left",
  "focus-right",
  "focus-up",
  "focus-down",
  "copy",
  "paste",
  "select-all",
  "search",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "toggle-matrix",
  "next-theme",
  "open-settings",
  "reload-settings",
  "arcade",
] as const;

export type Action =
  | (typeof BASE_ACTIONS)[number]
  | `go-to-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export function isAction(name: string): name is Action {
  return (BASE_ACTIONS as readonly string[]).includes(name) || /^go-to-tab-[1-9]$/.test(name);
}

export const DEFAULT_KEYBINDINGS: Record<string, Action> = {
  "ctrl+shift+t": "new-tab",
  "ctrl+shift+w": "close-pane",
  "ctrl+pagedown": "next-tab",
  "ctrl+pageup": "prev-tab",
  "ctrl+shift+e": "split-right",
  "ctrl+shift+o": "split-down",
  "ctrl+shift+z": "toggle-zoom",
  "alt+left": "focus-left",
  "alt+right": "focus-right",
  "alt+up": "focus-up",
  "alt+down": "focus-down",
  "ctrl+shift+c": "copy",
  "ctrl+shift+v": "paste",
  "ctrl+shift+a": "select-all",
  "ctrl+shift+f": "search",
  "ctrl+equal": "zoom-in",
  "ctrl+shift+equal": "zoom-in",
  "ctrl+numpadadd": "zoom-in",
  "ctrl+minus": "zoom-out",
  "ctrl+numpadsubtract": "zoom-out",
  "ctrl+0": "zoom-reset",
  "ctrl+shift+m": "toggle-matrix",
  "ctrl+shift+p": "next-theme",
  "ctrl+comma": "open-settings",
  "ctrl+shift+r": "reload-settings",
  "ctrl+shift+g": "arcade",
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`alt+${n}`, `go-to-tab-${n}` as Action]),
  ),
};

const MODIFIERS = ["ctrl", "alt", "shift", "super"];

const ALIASES: Record<string, string> = {
  control: "ctrl",
  meta: "super",
  cmd: "super",
  win: "super",
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  "=": "equal",
  "-": "minus",
  ",": "comma",
  ".": "period",
  "/": "slash",
  ";": "semicolon",
  "`": "backquote",
};

/**
 * Physical key (KeyboardEvent.code) → its name in key bindings. Bindings follow
 * the physical key, so they work the same with any keyboard layout.
 */
function keyName(code: string): string | null {
  if (/^(Control|Shift|Alt|Meta|OS)/.test(code)) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5).toLowerCase();
  // Comma → comma, PageUp → pageup, NumpadAdd → numpadadd, F5 → f5, …
  return code.toLowerCase();
}

/** "Ctrl+Shift+T" → "ctrl+shift+t" (modifiers in a fixed order); null if malformed */
export function normalizeCombo(text: string): string | null {
  const parts = text
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .map((p) => ALIASES[p] ?? p);
  const key = parts.pop();
  if (!key || MODIFIERS.includes(key)) return null;
  if (parts.some((p) => !MODIFIERS.includes(p))) return null;
  return [...MODIFIERS.filter((m) => parts.includes(m)), key].join("+");
}

export interface Keymap {
  bindings: Map<string, Action>;
  /** Problems in the user's keybindings, worth showing */
  errors: string[];
}

/**
 * The defaults with the user's keybindings from settings.json on top.
 * A `null` value removes a default binding.
 */
export function buildKeymap(user: unknown): Keymap {
  const bindings = new Map<string, Action>(Object.entries(DEFAULT_KEYBINDINGS));
  const errors: string[] = [];
  if (user && typeof user === "object") {
    for (const [combo, action] of Object.entries(user)) {
      const key = normalizeCombo(combo);
      if (!key) errors.push(`"${combo}" is not a valid key`);
      else if (action === null) bindings.delete(key);
      else if (typeof action === "string" && isAction(action)) bindings.set(key, action);
      else errors.push(`"${action}" is not an action`);
    }
  }
  return { bindings, errors };
}

/** The first key bound to an action, for menus: "ctrl+shift+c" → "Ctrl+Shift+C" */
export function shortcutLabel(bindings: Map<string, Action>, action: Action): string | null {
  for (const [combo, bound] of bindings) {
    if (bound === action) {
      return combo
        .split("+")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("+");
    }
  }
  return null;
}

/** The action bound to this key press, if any */
export function matchKey(bindings: Map<string, Action>, e: KeyboardEvent): Action | null {
  if (e.type !== "keydown") return null;
  const key = keyName(e.code);
  if (!key) return null;
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "super"];
  return bindings.get([...mods.filter(Boolean), key].join("+")) ?? null;
}
