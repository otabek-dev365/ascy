// Bounce — the smallest example game for Ascy. Copy this folder to start your own.
// Guide: https://github.com/otabek-dev365/ascy/blob/main/docs/games.md

const COLORS = ["brightCyan", "brightGreen", "brightYellow", "brightMagenta"];

ascy.game({
  // Called once at the start; `g` is your game's state, keep anything in it
  init(g, { width, height }) {
    g.width = width;
    g.height = height;
    g.x = width / 2;
    g.y = height / 2;
    g.vx = 20; // cells per second
    g.vy = 8;
    g.color = 0;
    g.bounces = ascy.storage.get("bounces") ?? 0; // saved between runs
  },

  // The pane changed size
  resize(g, { width, height }) {
    g.width = width;
    g.height = height;
  },

  // Every frame: read the keys, move things. dt = seconds since the last frame
  update(g, input, dt) {
    if (input.pressed("escape")) return ascy.exit();
    if (input.pressed("space")) g.color = (g.color + 1) % COLORS.length;
    if (input.held("left")) g.vx -= 40 * dt;
    if (input.held("right")) g.vx += 40 * dt;
    if (input.held("up")) g.vy -= 40 * dt;
    if (input.held("down")) g.vy += 40 * dt;

    g.x += g.vx * dt;
    g.y += g.vy * dt;
    if (g.x < 1 || g.x >= g.width - 1) {
      g.vx = -g.vx;
      g.x = Math.min(Math.max(g.x, 1), g.width - 2);
      bounced(g);
    }
    if (g.y < 2 || g.y >= g.height - 1) {
      g.vy = -g.vy;
      g.y = Math.min(Math.max(g.y, 2), g.height - 2);
      bounced(g);
    }
  },

  // Every frame: draw everything
  draw(g, screen) {
    screen.clear();
    screen.text(1, 0, `Bounce · ${g.bounces} bounces`, "white", null, "bold");
    screen.text(g.width - 34, 0, "Space color · arrows push · Esc", "gray");
    screen.box(0, 1, g.width, g.height - 1, "gray");
    screen.put(g.x, g.y, "●", COLORS[g.color]);
  },
});

function bounced(g) {
  g.bounces++;
  if (g.bounces % 10 === 0) ascy.storage.set("bounces", g.bounces);
}
