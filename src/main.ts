import { Channel, invoke } from "@tauri-apps/api/core";
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
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./settings";
import { resolveThemes, themeByName, type AppTheme, type ThemeRegistry } from "./theme";
import { buildKeymap, matchKey, shortcutLabel, type Action } from "./keys";
import { MatrixRain } from "./matrix";
import { Arcade } from "./arcade/arcade";

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
  /** A shell, or the arcade: the game list and the games (Ctrl+Shift+G) */
  kind: "shell" | "arcade";
  arcade: Arcade | null;
}

interface Tab {
  id: string;
  rootEl: HTMLElement;
  btn: HTMLElement;
  titleEl: HTMLElement;
  activePaneId: string | null;
  /** Set by renaming the tab; otherwise the tab shows its active pane's title */
  customTitle: string | null;
  /** The pane shown alone over the whole tab (Ctrl+Shift+Z) */
  zoomedPaneId: string | null;
}

const tabs = new Map<string, Tab>();
const panes = new Map<string, Pane>();
let activeTabId: string | null = null;
let settings: Settings;
let matrix: MatrixRain;
// Derived from settings by deriveFromSettings()
let keymap = buildKeymap(undefined).bindings;
let themeRegistry: ThemeRegistry = resolveThemes(undefined);

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

function currentTheme(): AppTheme {
  return themeByName(themeRegistry, settings.theme) ?? themeRegistry.themes.hacker;
}

function currentXtermTheme() {
  const t = currentTheme();
  return {
    ...t.xterm,
    background: settings.matrix ? t.bgTransparent : t.bgOpaque,
  };
}

function applyCssTheme() {
  const t = currentTheme();
  for (const [k, v] of Object.entries(t.css)) {
    document.documentElement.style.setProperty(k, v);
  }
}

// ---------- Keyboard shortcuts ----------

function matchShortcut(e: KeyboardEvent): Action | null {
  return matchKey(keymap, e);
}

function runShortcut(action: Action) {
  switch (action) {
    case "new-tab":
      newTab();
      break;
    case "close-pane": {
      const pane = activePane();
      if (pane) {
        const alone = panesOfTab(pane.tabId).length === 1;
        closeWithConfirm([pane.id], alone ? "this tab" : "this pane");
      }
      break;
    }
    case "split-right":
      split("row");
      break;
    case "split-down":
      split("col");
      break;
    case "toggle-zoom":
      toggleZoom();
      break;
    case "next-tab":
      cycle(1);
      break;
    case "prev-tab":
      cycle(-1);
      break;
    case "rename-tab":
      if (activeTabId) renameTab(activeTabId);
      break;
    case "arcade":
      toggleArcade();
      break;
    case "focus-left":
    case "focus-right":
    case "focus-up":
    case "focus-down":
      navigate(action);
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
    case "select-all":
      activePane()?.term.selectAll();
      break;
    case "zoom-in":
      zoom(1);
      break;
    case "zoom-out":
      zoom(-1);
      break;
    case "zoom-reset":
      zoom(0);
      break;
    case "toggle-matrix":
      settings.matrix = !settings.matrix;
      applyMatrix();
      applySettingsToTerms();
      saveSettings(settings);
      break;
    case "next-theme": {
      const names = Object.keys(themeRegistry.themes);
      settings.theme = names[(names.indexOf(settings.theme) + 1) % names.length];
      applySettingsToTerms();
      saveSettings(settings);
      break;
    }
    case "open-settings":
      invoke("settings_open");
      break;
    case "search":
      openSearch();
      break;
    case "reload-settings":
      reloadSettings();
      break;
    default: {
      const id = tabOrder()[Number(action.slice("go-to-tab-".length)) - 1];
      if (id) activateTab(id);
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

/** Processed output is acknowledged to the backend in batches of this size */
const ACK_BYTES = 64 * 1024;

/** Ctrl+click — so a plain click while selecting text doesn't open a link by accident */
function openLink(e: MouseEvent, uri: string) {
  if (e.ctrlKey) openUrl(uri).catch(() => {});
}

/** Opens a terminal inside an already placed .pane element and starts the shell */
/** The terminal and add-ons of a pane, opened in its element */
function makeTerminal(el: HTMLElement, kind: Pane["kind"]) {
  const term = new Terminal({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    cursorBlink: kind === "shell",
    scrollback: kind === "shell" ? settings.scrollback : 0,
    allowTransparency: true,
    theme: currentXtermTheme(),
    // OSC 8 hyperlinks (`ls --hyperlink`, compiler output); http(s) only
    linkHandler: { activate: openLink },
    // Needed for term.unicode below
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  if (kind === "shell") term.loadAddon(new WebLinksAddon(openLink));
  // Unicode 11 widths — emoji and CJK take two cells, so prompts don't drift
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
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
  return { term, fit, search, webgl };
}

async function bootPane(tabId: string, el: HTMLElement, cwd: string | null) {
  const id = el.dataset.paneId!;
  const { term, fit, search, webgl } = makeTerminal(el, "shell");
  const pane: Pane = {
    id,
    tabId,
    term,
    fit,
    search,
    el,
    webgl,
    title: "shell",
    unlisteners: [],
    kind: "shell",
    arcade: null,
  };
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

  // Shell output arrives as raw bytes. Once xterm.js has processed a chunk we
  // acknowledge it, and the backend pauses reading while too much is unacked.
  const output = new Channel<ArrayBuffer>();
  let processed = 0;
  output.onmessage = (buf) => {
    term.write(new Uint8Array(buf), () => {
      processed += buf.byteLength;
      if (processed >= ACK_BYTES) {
        invoke("pty_ack", { id, bytes: processed });
        processed = 0;
      }
    });
  };
  // Listen BEFORE spawn so an immediate exit isn't missed
  pane.unlisteners.push(await listen(`pty-exit-${id}`, () => closePane(id, true)));

  term.onData((data) => invoke("pty_write", { id, data }));
  // Old-style mouse reports are raw bytes, not UTF-8 text
  term.onBinary((data) =>
    invoke("pty_write_bytes", { id, data: Array.from(data, (c) => c.charCodeAt(0)) }),
  );
  term.onResize(({ cols, rows }) => invoke("pty_resize", { id, cols, rows }));
  term.onTitleChange((t) => {
    pane.title = t || "shell";
    const tab = tabs.get(tabId);
    if (tab?.activePaneId === id) refreshTitle(tab);
  });
  term.attachCustomKeyEventHandler((e) => !matchShortcut(e));
  el.addEventListener("focusin", () => setActivePane(id));

  safeFit(pane);
  try {
    await invoke("pty_spawn", { id, cols: term.cols, rows: term.rows, cwd, output });
  } catch (e) {
    term.write(`\x1b[31mCould not start the shell: ${e}\x1b[0m\r\n`);
  }
  setActivePane(id);
  term.focus();
}

/** Asks which directory the active pane's shell is in */
async function cwdOfActivePane(): Promise<string | null> {
  const pane = activePane();
  if (!pane) return null;
  return invoke<string | null>("pty_cwd", { id: pane.id }).catch(() => null);
}

/** Opens a tab in `cwd`, or by default where the active pane's shell is */
async function newTab(cwd?: string | null): Promise<string> {
  if (cwd === undefined) cwd = await cwdOfActivePane();
  const tab = createTab();
  const el = makePaneEl(newId());
  tab.rootEl.appendChild(el);
  await bootPane(tab.id, el, cwd);
  return tab.id;
}

/** Adds a tab (its button and an empty content area) and switches to it */
function createTab(): Tab {
  const tabId = newId();

  const rootEl = document.createElement("div");
  rootEl.className = "term";
  termsEl().appendChild(rootEl);

  const btn = document.createElement("div");
  btn.className = "tab";
  btn.dataset.tabId = tabId;
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
  titleEl.addEventListener("dblclick", () => renameTab(tabId));
  makeTabDraggable(btn);
  tabsEl().appendChild(btn);

  const tab: Tab = {
    id: tabId,
    rootEl,
    btn,
    titleEl,
    activePaneId: null,
    customTitle: null,
    zoomedPaneId: null,
  };
  tabs.set(tabId, tab);
  activateTab(tabId);
  return tab;
}

// ---------- Arcade (Ctrl+Shift+G) ----------

/** The tab the arcade was opened from: Esc / Ctrl+Shift+G go back to it */
let tabBeforeArcade: string | null = null;

function arcadeTab(): Tab | undefined {
  const pane = [...panes.values()].find((p) => p.kind === "arcade");
  return pane ? tabs.get(pane.tabId) : undefined;
}

/** Opens the arcade in its own tab, or goes back to where you came from */
async function toggleArcade() {
  const tab = arcadeTab();
  if (tab && tab.id === activeTabId) return leaveArcade();
  tabBeforeArcade = activeTabId;
  if (tab) {
    activateTab(tab.id);
    return;
  }
  const newOne = createTab();
  const el = makePaneEl(newId());
  newOne.rootEl.appendChild(el);
  await bootArcadePane(newOne.id, el);
}

function leaveArcade() {
  if (tabBeforeArcade && tabBeforeArcade !== activeTabId && tabs.has(tabBeforeArcade)) {
    activateTab(tabBeforeArcade);
  }
}

/** A pane that runs the game list and the games instead of a shell */
async function bootArcadePane(tabId: string, el: HTMLElement) {
  const id = el.dataset.paneId!;
  el.classList.add("arcade");
  const { term, fit, search, webgl } = makeTerminal(el, "arcade");
  const pane: Pane = {
    id,
    tabId,
    term,
    fit,
    search,
    el,
    webgl,
    title: "Arcade",
    unlisteners: [],
    kind: "arcade",
    arcade: null,
  };
  panes.set(id, pane);
  paneRO.observe(el);
  const arcade = new Arcade(term, {
    setTitle: (title) => {
      pane.title = title;
      const tab = tabs.get(tabId);
      if (tab?.activePaneId === id) refreshTitle(tab);
    },
    leave: leaveArcade,
    accent: () => currentTheme().css["--accent"],
    toast: showToast,
  });
  pane.arcade = arcade;

  // Keys go to the game, except the app's own shortcuts
  term.attachCustomKeyEventHandler((e) => {
    if (matchShortcut(e)) return false;
    arcade.key(e);
    if (e.type === "keydown") e.preventDefault();
    return false;
  });
  term.textarea?.addEventListener("blur", () => arcade.blur());
  // The game gets the mouse (xterm itself doesn't, see .pane.arcade in the CSS)
  for (const type of ["pointerdown", "pointerup", "pointermove"] as const) {
    el.addEventListener(type, (e) => {
      if (type === "pointerdown") term.focus();
      arcade.mouse(e);
    });
  }
  el.addEventListener("wheel", (e) => arcade.mouse(e), { passive: true });
  el.addEventListener("focusin", () => setActivePane(id));
  term.onResize(({ cols, rows }) => arcade.resize(cols, rows));

  safeFit(pane);
  setActivePane(id);
  term.focus();
  arcade.setVisible(activeTabId === tabId);
  await arcade.showHub();
}

/** Copies a dropped game folder into the games folder and refreshes the list */
async function installGame(pane: Pane, path: string) {
  try {
    const id = await invoke<string>("game_install", { path });
    showToast(`Game installed: ${id}`);
    pane.arcade?.refresh();
  } catch (e) {
    showToast(`Can't install the game: ${e}`, true);
  }
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
  unzoom(tabs.get(pane.tabId)!);
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
  const ownTab = tabs.get(pane.tabId);
  if (ownTab) unzoom(ownTab);
  panes.delete(paneId);
  pane.unlisteners.forEach((u) => u());
  if (!fromExit && pane.kind === "shell") invoke("pty_kill", { id: paneId });
  pane.arcade?.dispose();
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
  closeWithConfirm(panesOfTab(tabId).map((p) => p.id), "this tab");
}

/** Programs (not just the shell) running in these panes */
async function runningPrograms(paneIds: string[]): Promise<string[]> {
  const shells = paneIds.filter((id) => panes.get(id)?.kind === "shell");
  const names = await Promise.all(
    shells.map((id) => invoke<string | null>("pty_foreground", { id }).catch(() => null)),
  );
  return names.filter((n): n is string => !!n);
}

/** Asks before closing if a program would be killed; true if it's fine to close */
async function okToClose(paneIds: string[], what: string): Promise<boolean> {
  if (!settings.confirmClose) return true;
  const running = await runningPrograms(paneIds);
  if (running.length === 0) return true;
  const list = [...new Set(running)].join(", ");
  const verb = running.length > 1 ? "are" : "is";
  return confirmDialog(`Close ${what}?`, `${list} ${verb} still running and will be stopped.`);
}

async function closeWithConfirm(paneIds: string[], what: string) {
  if (!(await okToClose(paneIds, what))) return;
  // Closing every pane of a tab takes the tab with it
  for (const id of paneIds) closePane(id);
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
    const ids = tabOrder();
    activateTab(ids[ids.length - 1]);
  }
}

function activateTab(tabId: string) {
  activeTabId = tabId;
  for (const [tid, t] of tabs) {
    t.rootEl.classList.toggle("active", tid === tabId);
    t.btn.classList.toggle("active", tid === tabId);
  }
  for (const p of panes.values()) p.arcade?.setVisible(p.tabId === tabId);
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
  refreshTitle(tab);
}

/** Alt+arrow — move to the geometrically nearest pane in that direction */
function navigate(dir: "focus-left" | "focus-right" | "focus-up" | "focus-down") {
  const cur = activePane();
  if (!cur || !activeTabId) return;
  // Moving to another pane ends the zoom (and needs the real pane positions)
  unzoom(tabs.get(activeTabId)!);
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
      dir === "focus-left" ? dx < -1
      : dir === "focus-right" ? dx > 1
      : dir === "focus-up" ? dy < -1
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

/** Shows the active pane alone over the whole tab, or back to the split */
function toggleZoom() {
  const tab = activeTab();
  const pane = activePane();
  if (!tab || !pane) return;
  if (tab.zoomedPaneId) {
    unzoom(tab);
  } else if (panesOfTab(tab.id).length > 1) {
    tab.zoomedPaneId = pane.id;
    pane.el.classList.add("zoomed");
    tab.rootEl.classList.add("zoomed");
    tab.btn.classList.add("zoomed");
  }
}

function unzoom(tab: Tab) {
  if (!tab.zoomedPaneId) return;
  panes.get(tab.zoomedPaneId)?.el.classList.remove("zoomed");
  tab.zoomedPaneId = null;
  tab.rootEl.classList.remove("zoomed");
  tab.btn.classList.remove("zoomed");
}

function cycle(dir: number) {
  const ids = tabOrder();
  if (!activeTabId || ids.length < 2) return;
  const i = ids.indexOf(activeTabId);
  activateTab(ids[(i + dir + ids.length) % ids.length]);
}

function syncWindowTitle() {
  const tab = activeTab();
  getCurrentWindow().setTitle(tab ? tabTitle(tab) : "Ascy");
}

// ---------- Tab titles and order ----------

/** Tab ids in the order shown in the tab bar (tabs can be dragged around) */
function tabOrder(): string[] {
  return [...tabsEl().children].map((b) => (b as HTMLElement).dataset.tabId!);
}

function tabTitle(tab: Tab): string {
  const pane = tab.activePaneId ? panes.get(tab.activePaneId) : undefined;
  return tab.customTitle ?? pane?.title ?? "shell";
}

function refreshTitle(tab: Tab) {
  tab.titleEl.textContent = tabTitle(tab);
  if (activeTabId === tab.id) syncWindowTitle();
}

/** Edits the tab's name in place: Enter saves, Esc cancels, empty = automatic again */
function renameTab(tabId: string) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.titleEl.isConnected) return;
  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = tabTitle(tab);
  input.spellcheck = false;
  tab.titleEl.replaceWith(input);
  input.select();
  let finished = false;
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    if (save) tab.customTitle = input.value.trim() || null;
    input.replaceWith(tab.titleEl);
    refreshTitle(tab);
    activePane()?.term.focus();
  };
  input.addEventListener("keydown", (e) => {
    // Typing must not reach the global shortcuts
    e.stopPropagation();
    if (e.code === "Enter") finish(true);
    else if (e.code === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

/** Dragging a tab sideways moves it; a press without movement stays a click */
function makeTabDraggable(btn: HTMLElement) {
  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    const startX = e.clientX;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 5) return;
      dragging = true;
      btn.classList.add("dragging");
      // Put the tab before the first other tab whose middle is right of the pointer
      const others = [...tabsEl().children].filter((c) => c !== btn);
      const before = others.find((c) => {
        const r = c.getBoundingClientRect();
        return ev.clientX < r.left + r.width / 2;
      });
      if (before) {
        if (btn.nextElementSibling !== before) tabsEl().insertBefore(btn, before);
      } else if (tabsEl().lastElementChild !== btn) {
        tabsEl().appendChild(btn);
      }
    };
    const up = () => {
      btn.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
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

/** Colors the slider track up to the thumb (see --fill in styles.css) */
function paintRange(el: HTMLInputElement) {
  const min = Number(el.min);
  const pct = ((Number(el.value) - min) / (Number(el.max) - min)) * 100;
  el.style.setProperty("--fill", `${pct}%`);
}

/** Fills the controls with the current settings when the panel opens */
function syncMenu() {
  const themeEl = document.getElementById("m-theme")!;
  themeEl.replaceChildren(
    ...Object.keys(themeRegistry.themes).map((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.theme = name;
      b.textContent = name;
      b.classList.toggle("active", name === settings.theme);
      b.setAttribute("aria-checked", String(name === settings.theme));
      return b;
    }),
  );
  (document.getElementById("m-matrix") as HTMLInputElement).checked = settings.matrix;
  const shade = Math.round(Math.min(0.9, Math.max(0, settings.shade)) * 100);
  const shadeInput = document.getElementById("m-shade") as HTMLInputElement;
  shadeInput.value = String(shade);
  paintRange(shadeInput);
  document.getElementById("m-shade-val")!.textContent = `${shade}%`;
  const fontInput = document.getElementById("m-font") as HTMLInputElement;
  fontInput.value = String(settings.fontSize);
  paintRange(fontInput);
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

  document.getElementById("m-theme")!.addEventListener("click", (e) => {
    const theme = (e.target as HTMLElement).closest("button")?.dataset.theme;
    if (!theme) return;
    settings.theme = theme as Settings["theme"];
    syncMenu();
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
    paintRange(shadeInput);
    document.getElementById("m-shade-val")!.textContent = `${shadeInput.value}%`;
    applyMatrix();
  });
  shadeInput.addEventListener("change", () => saveSettings(settings));

  const fontInput = document.getElementById("m-font") as HTMLInputElement;
  fontInput.addEventListener("input", () => {
    settings.fontSize = Number(fontInput.value);
    paintRange(fontInput);
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
    p.term.options.scrollback = p.kind === "shell" ? settings.scrollback : 0;
    p.term.options.theme = currentXtermTheme();
    safeFit(p);
  }
}

/** Rebuilds the key bindings and the theme list; returns problems to report */
function deriveFromSettings(): string[] {
  const keys = buildKeymap(settings.keybindings);
  keymap = keys.bindings;
  themeRegistry = resolveThemes(settings.themes);
  const errors = [...keys.errors, ...themeRegistry.errors];
  if (!themeByName(themeRegistry, settings.theme)) {
    errors.push(`theme "${settings.theme}" not found — using hacker`);
  }
  return errors.map((e) => `settings.json: ${e}`);
}

async function reloadSettings() {
  const { settings: loaded, error } = await loadSettings();
  // A broken file keeps the current settings instead of resetting everything
  if (loaded) settings = loaded;
  const problems = [...(error ? [error] : []), ...deriveFromSettings()];
  showToast(problems.length ? problems.join("\n") : "Settings reloaded", problems.length > 0);
  applyMatrix();
  applySettingsToTerms();
}

// ---------- Context menu (right click) ----------

function openContextMenu(e: MouseEvent, pane: Pane) {
  const tab = tabs.get(pane.tabId)!;
  const isSplit = panesOfTab(tab.id).length > 1;
  const items: ({ label: string; action: Action; enabled?: boolean } | "-")[] = [
    { label: "Copy", action: "copy", enabled: pane.term.hasSelection() },
    { label: "Paste", action: "paste" },
    { label: "Select all", action: "select-all" },
    "-",
    { label: "Split right", action: "split-right" },
    { label: "Split down", action: "split-down" },
    { label: tab.zoomedPaneId ? "Unzoom pane" : "Zoom pane", action: "toggle-zoom", enabled: isSplit },
    "-",
    { label: "Close pane", action: "close-pane" },
  ];
  const el = document.getElementById("ctxmenu")!;
  el.replaceChildren(
    ...items.map((item) => {
      if (item === "-") {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        return sep;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.disabled = item.enabled === false;
      const label = document.createElement("span");
      label.textContent = item.label;
      const key = document.createElement("span");
      key.className = "ctx-key";
      key.textContent = shortcutLabel(keymap, item.action) ?? "";
      b.append(label, key);
      b.addEventListener("click", () => {
        closeContextMenu();
        runShortcut(item.action);
      });
      return b;
    }),
  );
  el.hidden = false;
  // Open at the pointer, but keep the whole menu inside the window
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - height - 4))}px`;
}

function closeContextMenu() {
  const el = document.getElementById("ctxmenu")!;
  if (el.hidden) return;
  el.hidden = true;
  activePane()?.term.focus();
}

function initContextMenu() {
  termsEl().addEventListener("contextmenu", (e) => {
    const paneEl = (e.target as HTMLElement).closest<HTMLElement>(".pane");
    const pane = paneEl ? panes.get(paneEl.dataset.paneId ?? "") : undefined;
    if (!pane) return;
    e.preventDefault();
    if (pane.kind === "arcade") return;
    // Apps with mouse support (vim, htop, …) get the right click;
    // Shift+right click still opens the menu
    if (pane.term.modes.mouseTrackingMode !== "none" && !e.shiftKey) return;
    setActivePane(pane.id);
    openContextMenu(e, pane);
  });
  const menu = document.getElementById("ctxmenu")!;
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target as Node)) closeContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.code === "Escape") closeContextMenu();
  });
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);
}

// ---------- Session (tabs reopened on the next start) ----------

interface SavedSession {
  tabs: { cwd: string | null; title: string | null }[];
  active: number;
}

let lastSavedSession = "";

/** Writes the open tabs (directory, custom name) to session.json if they changed */
async function saveSession() {
  if (!settings.restoreSession) return;
  // Only shell tabs are reopened; the arcade is one keypress away
  const order = tabOrder().filter((id) => panesOfTab(id).some((p) => p.kind === "shell"));
  const session: SavedSession = {
    tabs: await Promise.all(
      order.map(async (id) => {
        const tab = tabs.get(id)!;
        const active = tab.activePaneId ? panes.get(tab.activePaneId) : undefined;
        const shell = active?.kind === "shell" ? active : panesOfTab(id).find((p) => p.kind === "shell");
        const cwd = shell
          ? await invoke<string | null>("pty_cwd", { id: shell.id }).catch(() => null)
          : null;
        return { cwd, title: tab.customTitle };
      }),
    ),
    active: Math.max(0, order.indexOf(activeTabId ?? "")),
  };
  const text = JSON.stringify(session);
  if (text === lastSavedSession) return;
  lastSavedSession = text;
  await invoke("session_save", { session }).catch(() => {});
}

/** Reopens the tabs of the last run; false if there was nothing to restore */
async function restoreSession(): Promise<boolean> {
  if (!settings.restoreSession) return false;
  const saved = await invoke<SavedSession | null>("session_load").catch(() => null);
  const list = Array.isArray(saved?.tabs) ? saved.tabs : [];
  if (list.length === 0) return false;
  for (const t of list) {
    const tab = tabs.get(await newTab(typeof t?.cwd === "string" ? t.cwd : null));
    if (tab && typeof t?.title === "string") {
      tab.customTitle = t.title;
      refreshTitle(tab);
    }
  }
  const order = tabOrder();
  const active = Number(saved?.active) || 0;
  activateTab(order[Math.min(Math.max(0, active), order.length - 1)]);
  return true;
}

// ---------- Confirmation dialog ----------

/** Themed yes/no dialog (native ones ignore the theme); resolves true on "Close" */
function confirmDialog(title: string, text: string): Promise<boolean> {
  const el = document.getElementById("dialog")!;
  const ok = document.getElementById("dialog-ok") as HTMLButtonElement;
  const cancel = document.getElementById("dialog-cancel") as HTMLButtonElement;
  document.getElementById("dialog-title")!.textContent = title;
  document.getElementById("dialog-text")!.textContent = text;
  el.hidden = false;
  ok.focus();
  return new Promise((resolve) => {
    const done = (answer: boolean) => {
      el.hidden = true;
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("click", onClick);
      activePane()?.term.focus();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      // Keep keys away from the terminal and the global shortcuts
      e.stopPropagation();
      if (e.code === "Escape") done(false);
    };
    const onClick = (e: MouseEvent) => {
      if (e.target === ok) done(true);
      else if (e.target === cancel || e.target === el) done(false);
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("click", onClick);
  });
}

// ---------- Notifications ----------

let toastTimer = 0;

/** Shows a short message in the bottom corner; errors stay longer */
function showToast(text: string, isError = false) {
  const el = document.getElementById("toast")!;
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), isError ? 10000 : 2500);
}

// ---------- Startup ----------

async function main() {
  // If the page was reloaded, kill the shells left over from the previous session
  await invoke("pty_kill_all").catch(() => {});
  const { settings: loaded, error } = await loadSettings();
  settings = loaded ?? { ...DEFAULT_SETTINGS };
  const problems = [...(error ? [error] : []), ...deriveFromSettings()];
  matrix = new MatrixRain(document.getElementById("matrix") as HTMLCanvasElement);
  applyCssTheme();
  applyMatrix();
  if (problems.length) showToast(problems.join("\n"), true);
  const toast = document.getElementById("toast")!;
  toast.addEventListener("click", () => (toast.hidden = true));

  document.getElementById("newtab")!.addEventListener("click", () => newTab());
  initSearchBar();
  initMenu();
  initContextMenu();
  // Closing the window (title bar ×, Alt+F4) asks too if programs are running;
  // once it's really closing, the open tabs are saved for the next start
  await getCurrentWindow().onCloseRequested(async (event) => {
    if (!(await okToClose([...panes.keys()], "Ascy"))) event.preventDefault();
    else await saveSession();
  });
  // Also save now and then, in case the app doesn't get to close cleanly (logout)
  setInterval(saveSession, 30_000);

  window.addEventListener("blur", () => {
    for (const p of panes.values()) p.arcade?.blur();
  });

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
      if (pane?.kind === "arcade") {
        for (const path of p.paths) installGame(pane, path);
      } else if (pane) {
        pane.term.paste(p.paths.map(quotePath).join(" ") + " ");
        pane.term.focus();
      }
    }
  });

  if (!(await restoreSession())) await newTab();
}

window.addEventListener("DOMContentLoaded", main);
