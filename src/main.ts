import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./settings";
import { getTheme } from "./theme";
import { MatrixRain } from "./matrix";

interface Pane {
  id: string;
  tabId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLElement;
  webgl: WebglAddon | null;
  title: string;
  unlisteners: UnlistenFn[];
}

interface Tab {
  id: string;
  rootEl: HTMLElement;
  btn: HTMLElement;
  titleEl: HTMLElement;
  activePaneId: string | null;
}

const tabs = new Map<string, Tab>();
const panes = new Map<string, Pane>();
let activeTabId: string | null = null;
let settings: Settings;
let matrix: MatrixRain;

// Unique IDs so a page reload (dev HMR) never collides with an old session
const newId = () => `t-${crypto.randomUUID().slice(0, 8)}`;

const tabsEl = () => document.getElementById("tabs")!;
const termsEl = () => document.getElementById("terms")!;

// Refit a pane whenever its size changes (split, window resize, tab switch)
const paneRO = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const pane = panes.get((entry.target as HTMLElement).dataset.paneId ?? "");
    if (pane) safeFit(pane);
  }
});

function safeFit(pane: Pane) {
  if (pane.el.offsetWidth > 0 && pane.el.offsetHeight > 0) pane.fit.fit();
}

function activeTab(): Tab | null {
  return activeTabId ? (tabs.get(activeTabId) ?? null) : null;
}

function activePane(): Pane | null {
  const tab = activeTab();
  return tab?.activePaneId ? (panes.get(tab.activePaneId) ?? null) : null;
}

function panesOfTab(tabId: string): Pane[] {
  return [...panes.values()].filter((p) => p.tabId === tabId);
}

function currentXtermTheme() {
  const t = getTheme(settings.theme);
  return {
    ...t.xterm,
    background: settings.matrix ? t.bgTransparent : t.bgOpaque,
  };
}

function applyCssTheme() {
  const t = getTheme(settings.theme);
  for (const [k, v] of Object.entries(t.css)) {
    document.documentElement.style.setProperty(k, v);
  }
}

// ---------- Keyboard shortcuts ----------

type Action =
  | "newtab" | "closepane" | "next" | "prev"
  | "split-side" | "split-down"
  | "copy" | "paste"
  | "zoomin" | "zoomout" | "zoomreset"
  | "matrix" | "theme" | "settings" | "reload" | "search"
  | `goto:${number}`
  | `nav:${string}`;

function matchShortcut(e: KeyboardEvent): Action | null {
  if (e.type !== "keydown") return null;
  const { ctrlKey: ctrl, shiftKey: shift, altKey: alt, code } = e;
  if (ctrl && shift && code === "KeyT") return "newtab";
  if (ctrl && shift && code === "KeyW") return "closepane";
  if (ctrl && shift && code === "KeyE") return "split-side";
  if (ctrl && shift && code === "KeyF") return "search";
  if (ctrl && shift && code === "KeyO") return "split-down";
  if (ctrl && shift && code === "KeyC") return "copy";
  if (ctrl && shift && code === "KeyV") return "paste";
  if (ctrl && shift && code === "KeyM") return "matrix";
  if (ctrl && shift && code === "KeyP") return "theme";
  if (ctrl && shift && code === "KeyR") return "reload";
  if (ctrl && !shift && code === "Comma") return "settings";
  if (ctrl && !shift && code === "PageDown") return "next";
  if (ctrl && !shift && code === "PageUp") return "prev";
  if (ctrl && (code === "Equal" || code === "NumpadAdd")) return "zoomin";
  if (ctrl && (code === "Minus" || code === "NumpadSubtract")) return "zoomout";
  if (ctrl && !shift && code === "Digit0") return "zoomreset";
  if (alt && /^Digit[1-9]$/.test(code)) return `goto:${Number(code.slice(5))}`;
  if (alt && /^Arrow(Left|Right|Up|Down)$/.test(code)) return `nav:${code}`;
  return null;
}

function runShortcut(action: Action) {
  switch (action) {
    case "newtab":
      newTab();
      break;
    case "closepane": {
      const pane = activePane();
      if (pane) closePane(pane.id);
      break;
    }
    case "split-side":
      split("row");
      break;
    case "split-down":
      split("col");
      break;
    case "next":
      cycle(1);
      break;
    case "prev":
      cycle(-1);
      break;
    case "copy": {
      const sel = activePane()?.term.getSelection();
      if (sel) writeText(sel).catch(() => {});
      break;
    }
    case "paste": {
      const pane = activePane();
      if (pane) {
        // term.paste() honors bracketed paste mode — multi-line text
        // is not executed by the shell right away
        readText()
          .then((t) => t && pane.term.paste(t))
          .catch(() => {});
      }
      break;
    }
    case "zoomin":
      zoom(1);
      break;
    case "zoomout":
      zoom(-1);
      break;
    case "zoomreset":
      zoom(0);
      break;
    case "matrix":
      settings.matrix = !settings.matrix;
      applyMatrix();
      applySettingsToTerms();
      saveSettings(settings);
      break;
    case "theme":
      settings.theme = settings.theme === "hacker" ? "night" : "hacker";
      applySettingsToTerms();
      saveSettings(settings);
      break;
    case "settings":
      invoke("settings_open");
      break;
    case "search":
      openSearch();
      break;
    case "reload":
      reloadSettings();
      break;
    default:
      if (action.startsWith("goto:")) {
        const id = [...tabs.keys()][Number(action.slice(5)) - 1];
        if (id) activateTab(id);
      } else if (action.startsWith("nav:")) {
        navigate(action.slice(4));
      }
  }
}

// ---------- Pane management ----------

function makePaneEl(id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pane";
  el.dataset.paneId = id;
  return el;
}

/** Opens a terminal inside an already placed .pane element and starts the shell */
async function bootPane(tabId: string, el: HTMLElement, cwd: string | null) {
  const id = el.dataset.paneId!;

  const term = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    cursorBlink: true,
    scrollback: settings.scrollback,
    allowTransparency: true,
    theme: currentXtermTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  // Ctrl+click — so a plain click while selecting text doesn't open a link by accident
  term.loadAddon(new WebLinksAddon((e, uri) => e.ctrlKey && openUrl(uri)));
  term.open(el);

  // The WebGL renderer can't draw a transparent background — stay on the DOM renderer while matrix is on
  let webgl: WebglAddon | null = null;
  if (!settings.matrix) {
    try {
      webgl = new WebglAddon();
      term.loadAddon(webgl);
    } catch {
      webgl = null;
    }
  }

  const pane: Pane = { id, tabId, term, fit, search, el, webgl, title: "shell", unlisteners: [] };
  panes.set(id, pane);
  paneRO.observe(el);

  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (searchPaneId !== id) return;
    const countEl = document.getElementById("searchcount")!;
    // With 1000+ matches the addon doesn't compute the index (resultIndex = -1)
    countEl.textContent =
      resultCount <= 0 ? "0/0"
      : resultIndex >= 0 ? `${resultIndex + 1}/${resultCount}`
      : `${resultCount}+`;
  });

  // Listeners go BEFORE spawn so the shell's first prompt isn't lost
  pane.unlisteners.push(
    await listen<string>(`pty-output-${id}`, (e) => term.write(e.payload)),
  );
  pane.unlisteners.push(await listen(`pty-exit-${id}`, () => closePane(id, true)));

  term.onData((data) => invoke("pty_write", { id, data }));
  term.onResize(({ cols, rows }) => invoke("pty_resize", { id, cols, rows }));
  term.onTitleChange((t) => {
    pane.title = t || "shell";
    const tab = tabs.get(tabId);
    if (tab?.activePaneId === id) {
      tab.titleEl.textContent = pane.title;
      if (activeTabId === tabId) syncWindowTitle();
    }
  });
  term.attachCustomKeyEventHandler((e) => !matchShortcut(e));
  el.addEventListener("focusin", () => setActivePane(id));

  safeFit(pane);
  await invoke("pty_spawn", { id, cols: term.cols, rows: term.rows, cwd });
  setActivePane(id);
  term.focus();
}

/** Asks which directory the active pane's shell is in */
async function cwdOfActivePane(): Promise<string | null> {
  const pane = activePane();
  if (!pane) return null;
  return invoke<string | null>("pty_cwd", { id: pane.id }).catch(() => null);
}

async function newTab() {
  const cwd = await cwdOfActivePane();
  const tabId = newId();

  const rootEl = document.createElement("div");
  rootEl.className = "term";
  termsEl().appendChild(rootEl);

  const btn = document.createElement("div");
  btn.className = "tab";
  const titleEl = document.createElement("span");
  titleEl.textContent = "shell";
  const closeEl = document.createElement("button");
  closeEl.textContent = "×";
  closeEl.title = "Close tab";
  closeEl.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeTab(tabId);
  });
  btn.append(titleEl, closeEl);
  btn.addEventListener("click", () => activateTab(tabId));
  tabsEl().appendChild(btn);

  tabs.set(tabId, { id: tabId, rootEl, btn, titleEl, activePaneId: null });
  activateTab(tabId);

  const el = makePaneEl(newId());
  rootEl.appendChild(el);
  await bootPane(tabId, el, cwd);
}

/** Mouse-draggable divider between two panes */
function makeGutter(dir: "row" | "col", wrap: HTMLElement): HTMLElement {
  const g = document.createElement("div");
  g.className = `gutter ${dir}`;
  g.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add("dragging");
    const first = g.previousElementSibling as HTMLElement;
    const rect = wrap.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const frac =
        dir === "row"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      const pct = Math.min(85, Math.max(15, frac * 100));
      first.style.flex = `0 0 calc(${pct}% - 3px)`;
    };
    const up = () => {
      g.classList.remove("dragging");
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
  });
  return g;
}

/** Splits the active pane in two: row = side by side, col = stacked */
async function split(dir: "row" | "col") {
  const pane = activePane();
  if (!pane) return;
  const cwd = await cwdOfActivePane();

  const parent = pane.el.parentElement!;
  const wrap = document.createElement("div");
  wrap.className = `split ${dir}`;
  // The pane's share in the outer split (inline flex) moves to the wrapper
  wrap.style.flex = pane.el.style.flex;
  pane.el.style.flex = "";
  parent.insertBefore(wrap, pane.el);
  wrap.appendChild(pane.el);
  wrap.appendChild(makeGutter(dir, wrap));

  const el = makePaneEl(newId());
  wrap.appendChild(el);
  await bootPane(pane.tabId, el, cwd);
}

function closePane(paneId: string, fromExit = false) {
  const pane = panes.get(paneId);
  if (!pane) return;
  if (searchPaneId === paneId) closeSearch(false);
  panes.delete(paneId);
  pane.unlisteners.forEach((u) => u());
  if (!fromExit) invoke("pty_kill", { id: paneId });
  paneRO.unobserve(pane.el);
  pane.term.dispose();

  const parent = pane.el.parentElement;
  // Remove the adjacent gutter together with the pane
  if (parent?.classList.contains("split")) {
    const sib = pane.el.previousElementSibling ?? pane.el.nextElementSibling;
    if (sib?.classList.contains("gutter")) sib.remove();
  }
  pane.el.remove();
  // If a split is left with one child, unwrap it — keeps the tree flat
  if (parent?.classList.contains("split") && parent.children.length === 1) {
    const child = parent.firstElementChild as HTMLElement;
    child.style.flex = parent.style.flex;
    parent.replaceWith(child);
  }

  const tab = tabs.get(pane.tabId);
  if (!tab) return;
  const remaining = panesOfTab(pane.tabId);
  if (remaining.length === 0) {
    removeTab(tab);
    return;
  }
  if (tab.activePaneId === paneId) {
    setActivePane(remaining[remaining.length - 1].id);
    remaining[remaining.length - 1].term.focus();
  }
}

function closeTab(tabId: string) {
  // Close every pane — the last one takes the tab with it
  for (const pane of panesOfTab(tabId)) closePane(pane.id);
}

function removeTab(tab: Tab) {
  tabs.delete(tab.id);
  tab.btn.remove();
  tab.rootEl.remove();
  if (tabs.size === 0) {
    getCurrentWindow().close();
    return;
  }
  if (activeTabId === tab.id) {
    const ids = [...tabs.keys()];
    activateTab(ids[ids.length - 1]);
  }
}

function activateTab(tabId: string) {
  activeTabId = tabId;
  for (const [tid, t] of tabs) {
    t.rootEl.classList.toggle("active", tid === tabId);
    t.btn.classList.toggle("active", tid === tabId);
  }
  const tab = tabs.get(tabId)!;
  requestAnimationFrame(() => {
    for (const p of panesOfTab(tabId)) safeFit(p);
    const pane = tab.activePaneId ? panes.get(tab.activePaneId) : null;
    pane?.term.focus();
  });
  syncWindowTitle();
}

function setActivePane(paneId: string) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const tab = tabs.get(pane.tabId);
  if (!tab) return;
  tab.activePaneId = paneId;
  for (const p of panesOfTab(pane.tabId)) {
    p.el.classList.toggle("focused", p.id === paneId);
  }
  tab.titleEl.textContent = pane.title;
  if (activeTabId === pane.tabId) syncWindowTitle();
}

/** Alt+arrow — move to the geometrically nearest pane in that direction */
function navigate(arrowCode: string) {
  const cur = activePane();
  if (!cur || !activeTabId) return;
  const r = cur.el.getBoundingClientRect();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  let best: Pane | null = null;
  let bestDist = Infinity;
  for (const p of panesOfTab(activeTabId)) {
    if (p.id === cur.id) continue;
    const pr = p.el.getBoundingClientRect();
    const dx = pr.x + pr.width / 2 - cx;
    const dy = pr.y + pr.height / 2 - cy;
    const towards =
      arrowCode === "ArrowLeft" ? dx < -1
      : arrowCode === "ArrowRight" ? dx > 1
      : arrowCode === "ArrowUp" ? dy < -1
      : dy > 1;
    if (!towards) continue;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  if (best) {
    setActivePane(best.id);
    best.term.focus();
  }
}

function cycle(dir: number) {
  const ids = [...tabs.keys()];
  if (!activeTabId || ids.length < 2) return;
  const i = ids.indexOf(activeTabId);
  activateTab(ids[(i + dir + ids.length) % ids.length]);
}

function syncWindowTitle() {
  getCurrentWindow().setTitle(activePane()?.title || "Ascy");
}

// ---------- Search (Ctrl+Shift+F) ----------

let searchPaneId: string | null = null;

// Yellow/orange highlights read well in both themes
const SEARCH_DECORATIONS = {
  matchBackground: "#e0af6845",
  matchOverviewRuler: "#e0af68",
  activeMatchBackground: "#ff9e64a0",
  activeMatchColorOverviewRuler: "#ff9e64",
};

const searchBar = () => document.getElementById("searchbar")!;
const searchInput = () => document.getElementById("searchinput") as HTMLInputElement;

function openSearch() {
  const pane = activePane();
  if (!pane) return;
  // If search was left open in another pane, clear its highlights
  if (searchPaneId && searchPaneId !== pane.id) {
    panes.get(searchPaneId)?.search.clearDecorations();
  }
  searchPaneId = pane.id;
  searchBar().hidden = false;
  searchInput().select();
  searchInput().focus();
}

function closeSearch(refocus = true) {
  const pane = searchPaneId ? panes.get(searchPaneId) : null;
  pane?.search.clearDecorations();
  searchPaneId = null;
  searchBar().hidden = true;
  document.getElementById("searchcount")!.textContent = "";
  if (refocus) pane?.term.focus();
}

function doSearch(dir: 1 | -1, incremental = false) {
  const pane = searchPaneId ? panes.get(searchPaneId) : null;
  if (!pane) return;
  const q = searchInput().value;
  if (!q) {
    pane.search.clearDecorations();
    document.getElementById("searchcount")!.textContent = "";
    return;
  }
  const opts = { incremental, decorations: SEARCH_DECORATIONS };
  if (dir === 1) pane.search.findNext(q, opts);
  else pane.search.findPrevious(q, opts);
}

function initSearchBar() {
  searchInput().addEventListener("keydown", (e) => {
    if (e.code === "Escape") closeSearch();
    else if (e.code === "Enter") doSearch(e.shiftKey ? -1 : 1);
    // Keep typed keys away from the global shortcut handler
    e.stopPropagation();
  });
  searchInput().addEventListener("input", () => doSearch(1, true));
  document.getElementById("searchnext")!.addEventListener("click", () => doSearch(1));
  document.getElementById("searchprev")!.addEventListener("click", () => doSearch(-1));
  document.getElementById("searchclose")!.addEventListener("click", () => closeSearch());
}

// ---------- Menu (☰) ----------

const menuEl = () => document.getElementById("menu")!;

/** Fills the controls with the current settings when the panel opens */
function syncMenu() {
  (document.getElementById("m-theme") as HTMLSelectElement).value = settings.theme;
  (document.getElementById("m-matrix") as HTMLInputElement).checked = settings.matrix;
  const shade = Math.round(Math.min(0.9, Math.max(0, settings.shade)) * 100);
  (document.getElementById("m-shade") as HTMLInputElement).value = String(shade);
  document.getElementById("m-shade-val")!.textContent = `${shade}%`;
  (document.getElementById("m-font") as HTMLInputElement).value = String(settings.fontSize);
  document.getElementById("m-font-val")!.textContent = `${settings.fontSize}px`;
}

function toggleMenu(show?: boolean) {
  const el = menuEl();
  const willShow = show ?? el.hidden;
  if (willShow) syncMenu();
  el.hidden = !willShow;
  document.getElementById("menubtn")!.classList.toggle("open", willShow);
  if (!willShow) activePane()?.term.focus();
}

function initMenu() {
  const el = menuEl();
  document.getElementById("menubtn")!.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  // Close when clicking outside the panel
  el.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => {
    if (!el.hidden) toggleMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && !el.hidden) toggleMenu(false);
  });

  (document.getElementById("m-theme") as HTMLSelectElement).addEventListener("change", (e) => {
    settings.theme = (e.target as HTMLSelectElement).value as Settings["theme"];
    applySettingsToTerms();
    saveSettings(settings);
  });
  (document.getElementById("m-matrix") as HTMLInputElement).addEventListener("change", (e) => {
    settings.matrix = (e.target as HTMLInputElement).checked;
    applyMatrix();
    applySettingsToTerms();
    saveSettings(settings);
  });

  // Sliders apply live while dragging and are saved to the file on release
  const shadeInput = document.getElementById("m-shade") as HTMLInputElement;
  shadeInput.addEventListener("input", () => {
    settings.shade = Number(shadeInput.value) / 100;
    document.getElementById("m-shade-val")!.textContent = `${shadeInput.value}%`;
    applyMatrix();
  });
  shadeInput.addEventListener("change", () => saveSettings(settings));

  const fontInput = document.getElementById("m-font") as HTMLInputElement;
  fontInput.addEventListener("input", () => {
    settings.fontSize = Number(fontInput.value);
    document.getElementById("m-font-val")!.textContent = `${fontInput.value}px`;
    applySettingsToTerms();
  });
  fontInput.addEventListener("change", () => saveSettings(settings));

  document.getElementById("m-settings")!.addEventListener("click", () => invoke("settings_open"));
  document.getElementById("m-reload")!.addEventListener("click", async () => {
    await reloadSettings();
    syncMenu();
  });
}

// ---------- Settings ----------

function zoom(dir: number) {
  settings.fontSize =
    dir === 0
      ? DEFAULT_SETTINGS.fontSize
      : Math.min(28, Math.max(8, settings.fontSize + dir));
  applySettingsToTerms();
  saveSettings(settings);
}

function applyMatrix() {
  document.body.classList.toggle("matrix", settings.matrix);
  const shade = Math.min(0.9, Math.max(0, settings.shade));
  document.getElementById("shade")!.style.background = `rgba(0, 0, 0, ${shade})`;
  if (settings.matrix) matrix.start();
  else matrix.stop();
}

function applySettingsToTerms() {
  applyCssTheme();
  for (const p of panes.values()) {
    // Matrix ⇄ WebGL switch: transparency only works with the DOM renderer
    if (settings.matrix && p.webgl) {
      p.webgl.dispose();
      p.webgl = null;
    } else if (!settings.matrix && !p.webgl) {
      try {
        p.webgl = new WebglAddon();
        p.term.loadAddon(p.webgl);
      } catch {
        p.webgl = null;
      }
    }
    p.term.options.fontSize = settings.fontSize;
    p.term.options.fontFamily = settings.fontFamily;
    p.term.options.scrollback = settings.scrollback;
    p.term.options.theme = currentXtermTheme();
    safeFit(p);
  }
}

async function reloadSettings() {
  settings = await loadSettings();
  applyMatrix();
  applySettingsToTerms();
}

// ---------- Startup ----------

async function main() {
  // If the page was reloaded, kill the shells left over from the previous session
  await invoke("pty_kill_all").catch(() => {});
  settings = await loadSettings();
  matrix = new MatrixRain(document.getElementById("matrix") as HTMLCanvasElement);
  applyCssTheme();
  applyMatrix();

  document.getElementById("newtab")!.addEventListener("click", () => newTab());
  initSearchBar();
  initMenu();
  window.addEventListener("keydown", (e) => {
    const action = matchShortcut(e);
    if (action) {
      e.preventDefault();
      runShortcut(action);
    }
  });

  // Dropped files are typed into the active shell as paths.
  // Paths with special characters are single-quoted (POSIX rules).
  const quotePath = (p: string) =>
    /^[A-Za-z0-9_\-./~:@%+=,]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
  await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "over") return;
    document.body.classList.toggle("dragover", p.type === "enter");
    if (p.type === "drop" && p.paths.length) {
      const pane = activePane();
      if (pane) {
        pane.term.paste(p.paths.map(quotePath).join(" ") + " ");
        pane.term.focus();
      }
    }
  });

  await newTab();
}

window.addEventListener("DOMContentLoaded", main);
