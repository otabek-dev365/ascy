// Ascy Arcade — the game list (Ctrl+Shift+G).
// It is an Ascy game itself, written with the same API as any other game,
// plus ascy.system: the list of games and a few actions only it may use.

const LOGO = [
  "▄▀█ █▀ █▀▀ █▄█   ▄▀█ █▀█ █▀▀ ▄▀█ █▀▄ █▀▀",
  "█▀█ ▄█ █▄▄  █    █▀█ █▀▄ █▄▄ █▀█ █▄▀ ██▄",
];
const CARD_W = 24;
const CARD_H = 8;
const GAP_X = 2;
const GAP_Y = 1;

const MAKE_COVER = ["", "   ╷   ", "───┼───", "   ╵   "];
const BROKEN_COVER = ["", "╲   ╱", "  ╳  ", "╱   ╲"];

ascy.game({
  init(g, size) {
    g.w = size.width;
    g.h = size.height;
    g.t = 0; // since the selection last moved (for the blinking marker)
    g.clock = 0; // since the list opened (for the logo)
    g.scroll = 0;
    g.hits = [];
    g.sel = Math.min(Math.max(0, ascy.system.selected | 0), items().length - 1);
  },

  resize(g, size) {
    g.w = size.width;
    g.h = size.height;
  },

  update(g, input, dt) {
    g.t += dt;
    g.clock += dt;
    const list = items();
    const { cols } = layout(g);
    const pressed = (...keys) => keys.some((k) => input.pressed(k));
    const move = (to) => {
      g.sel = Math.min(Math.max(0, to), list.length - 1);
      g.t = 0; // restart the blink, so the marker shows right away
    };

    if (pressed("left", "a", "h")) move(g.sel - 1);
    if (pressed("right", "d", "l")) move(g.sel + 1);
    if (pressed("up", "w", "k") && g.sel - cols >= 0) move(g.sel - cols);
    if (pressed("down", "s", "j") && Math.floor(g.sel / cols) < Math.floor((list.length - 1) / cols)) {
      move(g.sel + cols);
    }
    if (pressed("enter", "space")) activate(g, list[g.sel]);
    if (pressed("o")) ascy.system.openFolder();
    if (pressed("r")) ascy.system.reload();
    if (pressed("f1") || input.typed.includes("?")) ascy.system.openGuide();
    if (pressed("escape")) ascy.exit();

    const m = input.mouse;
    if (m.wheel) move(g.sel + Math.sign(m.wheel) * cols);
    if (m.pressed && m.button === 0) {
      const hit = g.hits.find((r) => m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h);
      if (hit && hit.i === g.sel) activate(g, list[hit.i]);
      else if (hit) move(hit.i);
    }
  },

  draw(g, s) {
    s.clear();
    const accent = ascy.system.accent || "brightGreen";
    const list = items();
    const { compact, cols, top, bottom } = layout(g);

    // Header
    if (!compact && g.w >= LOGO[0].length + 4) logo(g, s, 1, accent);
    else s.center(1, "ASCY ARCADE", accent, null, "bold");
    s.center(compact ? 2 : 3, "ASCII games, right in your terminal", "gray");

    // Cards (or a plain list when the window is small)
    const rowsFit = compact
      ? Math.max(1, bottom - top + 1)
      : Math.max(1, Math.floor((bottom - top + 1 + GAP_Y) / (CARD_H + GAP_Y)));
    const row = Math.floor(g.sel / cols);
    if (row < g.scroll) g.scroll = row;
    if (row >= g.scroll + rowsFit) g.scroll = row - rowsFit + 1;
    g.hits = [];
    const gridW = cols * CARD_W + (cols - 1) * GAP_X;
    const x0 = Math.floor((g.w - gridW) / 2);
    list.forEach((item, i) => {
      const r = Math.floor(i / cols) - g.scroll;
      if (r < 0 || r >= rowsFit) return;
      if (compact) {
        listRow(g, s, item, top + r, i === g.sel, accent);
        g.hits.push({ i, x: 0, y: top + r, w: g.w, h: 1 });
      } else {
        const x = x0 + (i % cols) * (CARD_W + GAP_X);
        const y = top + r * (CARD_H + GAP_Y);
        card(g, s, item, x, y, i === g.sel, accent);
        g.hits.push({ i, x, y, w: CARD_W, h: CARD_H });
      }
    });
    const lastRow = Math.floor((list.length - 1) / cols);
    if (g.scroll > 0) s.center(top - 1, "▲ more", "gray");
    if (lastRow >= g.scroll + rowsFit) s.center(bottom + 1, "▼ more", "gray");

    // Details of the selected game and the keys
    details(g, s, list[g.sel], accent);
    const keys =
      g.w >= 100 ? "←↑→↓ choose  ·  Enter play  ·  O games folder  ·  R reload  ·  ? make a game  ·  Esc back"
      : g.w >= 56 ? "←↑→↓ · Enter play · O folder · ? guide · Esc back"
      : "Enter play · ? guide · Esc back";
    s.center(g.h - 1, keys, "gray");
  },
});

/** The games, and a last card that invites to make one */
function items() {
  return [...ascy.system.games, { make: true, name: "Your game here", cover: MAKE_COVER }];
}

function layout(g) {
  const compact = g.w < CARD_W + 4 || g.h < 20;
  const cols = compact ? 1 : Math.max(1, Math.floor((g.w - 2 + GAP_X) / (CARD_W + GAP_X)));
  const top = compact ? 4 : 5;
  const bottom = g.h - 6; // last row for cards: details and keys go below
  return { compact, cols, top, bottom };
}

function activate(g, item) {
  if (!item) return;
  if (item.make) ascy.system.openGuide();
  else if (!item.error) ascy.system.launch(item.id, g.sel);
}

/** The logo, with a band of light sweeping across it every few seconds */
function logo(g, s, y, accent) {
  const width = [...LOGO[0]].length;
  const x0 = Math.floor((g.w - width) / 2);
  const sweep = ((g.clock * 15) % (width + 60)) - 10;
  LOGO.forEach((line, k) => {
    [...line].forEach((ch, i) => {
      if (ch === " ") return;
      const lit = Math.abs(i - sweep) < 2;
      s.put(x0 + i, y + k, ch, lit ? "brightWhite" : accent, null, lit ? "bold" : "");
    });
  });
}

function card(g, s, item, x, y, selected, accent) {
  const color = item.error ? "red" : item.make ? "gray" : item.color || accent;
  const border = selected ? accent : "gray";
  if (item.make) dashedBox(s, x, y, CARD_W, CARD_H, border);
  else s.box(x, y, CARD_W, CARD_H, border, null, selected ? "bold" : "");

  const cover = item.error ? BROKEN_COVER : item.cover || [];
  const inner = CARD_W - 4;
  cover.slice(0, 4).forEach((line, k) => {
    const chars = [...line].slice(0, inner);
    const lx = x + 2 + Math.floor((inner - chars.length) / 2);
    s.text(lx, y + 1 + k, chars.join(""), color, null, selected ? "" : "dim");
  });

  const ty = y + CARD_H - 2;
  if (selected && Math.floor(g.t * 2) % 2 === 0) s.put(x + 2, ty, "▶", accent);
  // The name gets what's left of the row after the best score (or the ✗)
  const best = item.best !== null && item.best !== undefined ? `★ ${item.best}` : "";
  const mark = item.error ? "✗" : best;
  const room = CARD_W - 6 - (mark ? [...mark].length + 1 : 0);
  const name = [...item.name.toUpperCase()].slice(0, room).join("");
  s.text(x + 4, ty, name, selected ? accent : "white", null, selected ? "bold" : "");
  if (item.error) s.put(x + CARD_W - 3, ty, "✗", "red");
  else if (best) s.text(x + CARD_W - 2 - [...best].length, ty, best, "yellow", null, selected ? "" : "dim");
}

function listRow(g, s, item, y, selected, accent) {
  if (selected) s.put(2, y, "▶", accent);
  s.text(4, y, item.name, item.error ? "red" : selected ? accent : "white", null, selected ? "bold" : "");
  if (item.best !== null && item.best !== undefined) {
    const best = `★ ${item.best}`;
    s.text(g.w - 2 - [...best].length, y, best, "yellow");
  }
}

function dashedBox(s, x, y, w, h, color) {
  for (let i = x + 1; i < x + w - 1; i++) {
    s.put(i, y, "┄", color);
    s.put(i, y + h - 1, "┄", color);
  }
  for (let j = y + 1; j < y + h - 1; j++) {
    s.put(x, j, "┆", color);
    s.put(x + w - 1, j, "┆", color);
  }
  s.put(x, y, "╭", color);
  s.put(x + w - 1, y, "╮", color);
  s.put(x, y + h - 1, "╰", color);
  s.put(x + w - 1, y + h - 1, "╯", color);
}

function details(g, s, item, accent) {
  if (!item) return;
  const y = g.h - 4;
  const width = g.w - 4;
  const fit = (str) => [...String(str)].slice(0, width).join("");
  s.text(2, y - 1, "─".repeat(Math.max(0, g.w - 4)), "gray", null, "dim");
  if (item.make) {
    s.text(2, y, "Make your own game", accent, null, "bold");
    s.text(2, y + 1, fit("One JavaScript file is enough, and an AI can write it with you. Press ? for the guide."));
    s.text(2, y + 2, fit("Then drag the game's folder onto this window, or put it into the games folder (O)."), "gray");
    return;
  }
  let x = s.text(2, y, item.name, item.error ? "red" : item.color || accent, null, "bold");
  if (item.author) x = s.text(x + 2, y, `by ${item.author}`, "gray");
  if (item.version) x = s.text(x + 2, y, `v${item.version}`, "gray");
  if (item.best !== null && item.best !== undefined) s.text(x + 2, y, `★ best ${item.best}`, "yellow");
  if (item.error) {
    s.text(2, y + 1, fit(`Can't be played: ${item.error}`), "red");
    return;
  }
  s.text(2, y + 1, fit(item.description || ""));
  s.text(2, y + 2, fit(item.controls || ""), "gray");
}
