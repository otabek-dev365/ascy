// Snake — built into Ascy, and written with the same API as any other game.
// Eat, grow longer, and don't hit the walls or your own tail.

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYS = {
  up: ["up", "w", "k"],
  down: ["down", "s", "j"],
  left: ["left", "a", "h"],
  right: ["right", "d", "l"],
};
const TITLE = [
  "█▀▀ █▄ █ ▄▀█ █▄▀ █▀▀",
  "▄▄█ █ ▀█ █▀█ █ █ ██▄",
];

ascy.game({
  init(g, size) {
    g.mode = "title"; // title → play ⇄ pause → over
    g.t = 0;
    layout(g, size);
  },

  resize(g, size) {
    layout(g, size);
    // A smaller field could cut through the snake: then that round is over
    if (g.snake?.some(([x, y]) => x >= g.cols || y >= g.rows)) g.mode = "title";
    else if (g.mode === "play") g.mode = "pause";
  },

  update(g, input, dt) {
    g.t += dt;
    const pressed = (...keys) => keys.some((k) => input.pressed(k));
    if (g.tooSmall) {
      if (pressed("escape")) ascy.exit();
      return;
    }
    switch (g.mode) {
      case "title":
        if (pressed("enter", "space")) start(g);
        else if (pressed("escape")) ascy.exit();
        break;
      case "over":
        if (pressed("enter", "space")) start(g);
        else if (pressed("escape")) g.mode = "title";
        break;
      case "pause":
        if (pressed("enter", "space", "p")) g.mode = "play";
        else if (pressed("escape")) g.mode = "title";
        break;
      case "play":
        if (pressed("escape", "p")) {
          g.mode = "pause";
          break;
        }
        for (const [dir, keys] of Object.entries(KEYS)) if (pressed(...keys)) turn(g, dir);
        g.clock += dt;
        while (g.mode === "play" && g.clock >= 1 / g.speed) {
          g.clock -= 1 / g.speed;
          step(g);
        }
        break;
    }
  },

  draw(g, s) {
    s.clear();
    if (g.tooSmall) {
      const ask = g.width >= 34 ? "Make the window a little bigger" : "Window too small";
      s.center(Math.floor(g.height / 2) - 1, ask, "yellow");
      s.center(Math.floor(g.height / 2) + 1, "Esc — back", "gray");
      return;
    }
    const right = g.x0 + g.cols * 2 + 2;

    // Score line
    s.text(g.x0, 0, " SNAKE ", "black", "green", "bold");
    let x = s.text(g.x0 + 9, 0, `score ${g.score ?? 0}`, "white");
    s.text(x + 3, 0, `best ${Math.max(ascy.best ?? 0, g.score ?? 0)}`, "yellow");
    if (g.mode === "play") s.text(right - 18, 0, "P pause · Esc menu", "gray");

    // Field: each snake cell is two characters wide, so it looks square
    s.box(g.x0, 1, g.cols * 2 + 2, g.rows + 2, "gray");
    if (g.mode === "title") return titleScreen(g, s);
    cell(g, s, g.food, "▐▌", "brightRed");
    for (let i = g.snake.length - 1; i >= 0; i--) {
      const tail = i === g.snake.length - 1;
      cell(g, s, g.snake[i], "██", i === 0 ? "brightGreen" : "green", tail ? "dim" : "");
    }
    if (g.mode === "pause") panel(g, s, ["PAUSED", "", "Enter  resume", "Esc    menu"], "yellow");
    if (g.mode === "over") {
      const score = `score ${g.score}` + (g.newBest ? "  ★ new best" : "");
      const head = g.won ? "YOU WIN" : "GAME OVER";
      panel(g, s, [head, "", score, "", "Enter  play again", "Esc    menu"], g.won ? "brightGreen" : "brightRed");
    }
  },
});

function layout(g, { width, height }) {
  g.width = width;
  g.height = height;
  g.cols = Math.floor((width - 2) / 2);
  g.rows = height - 3;
  g.tooSmall = g.cols < 12 || g.rows < 8;
  g.x0 = Math.floor((width - (g.cols * 2 + 2)) / 2); // left edge of the border
}

function start(g) {
  const x = Math.floor(g.cols / 3);
  const y = Math.floor(g.rows / 2);
  g.snake = [[x, y], [x - 1, y], [x - 2, y], [x - 3, y]]; // head first
  g.dir = "right";
  g.queue = []; // turns pressed faster than the snake moves
  g.score = 0;
  g.speed = 7; // cells per second
  g.clock = 0;
  g.newBest = false;
  g.won = false;
  placeFood(g);
  g.mode = "play";
  ascy.sound("select");
}

function turn(g, dir) {
  const last = g.queue.length ? g.queue[g.queue.length - 1] : g.dir;
  const [dx, dy] = DIRS[dir];
  const [lx, ly] = DIRS[last];
  if (dir === last || (dx === -lx && dy === -ly)) return; // no turning back into yourself
  if (g.queue.length < 2) g.queue.push(dir);
}

function step(g) {
  if (g.queue.length) g.dir = g.queue.shift();
  const [dx, dy] = DIRS[g.dir];
  const head = [g.snake[0][0] + dx, g.snake[0][1] + dy];
  const eats = head[0] === g.food[0] && head[1] === g.food[1];
  // Unless the snake grows, its tail moves away this step and isn't in the way
  const body = eats ? g.snake : g.snake.slice(0, -1);
  const wall = head[0] < 0 || head[1] < 0 || head[0] >= g.cols || head[1] >= g.rows;
  if (wall || body.some(([x, y]) => x === head[0] && y === head[1])) return gameOver(g, false);
  g.snake.unshift(head);
  if (!eats) {
    g.snake.pop();
    return;
  }
  g.score++;
  g.speed = Math.min(16, g.speed + 0.35);
  ascy.sound("pickup", { rate: 1 + Math.min(g.score, 30) * 0.02 }); // a little higher with every bite
  if (!placeFood(g)) gameOver(g, true);
}

/** Food on a random free cell; false when there's no room left */
function placeFood(g) {
  const taken = new Set(g.snake.map(([x, y]) => y * g.cols + x));
  const free = [];
  for (let i = 0; i < g.cols * g.rows; i++) if (!taken.has(i)) free.push(i);
  if (!free.length) return false;
  const i = free[Math.floor(Math.random() * free.length)];
  g.food = [i % g.cols, Math.floor(i / g.cols)];
  return true;
}

function gameOver(g, won) {
  g.mode = "over";
  ascy.sound(won ? "powerup" : "hurt");
  g.won = won;
  g.newBest = g.score > 0 && (ascy.best === null || g.score > ascy.best);
  ascy.score(g.score);
}

function cell(g, s, [cx, cy], chars, color, style) {
  s.text(g.x0 + 1 + cx * 2, 2 + cy, chars, color, null, style);
}

function titleScreen(g, s) {
  const mid = 2 + Math.floor(g.rows / 2) - 4;
  s.center(mid, TITLE.join("\n"), "brightGreen", null, "bold");
  if (Math.floor(g.t * 2) % 2 === 0) s.center(mid + 4, "Press Enter to start", "white", null, "bold");
  s.center(mid + 6, "←↑→↓ or WASD to move · P to pause", "gray");
  s.center(mid + 7, "Esc — back to the Arcade", "gray");
  // A little snake crawling along the bottom of the field
  const y = g.rows - 2;
  const head = Math.floor(g.t * 8) % (g.cols + 6);
  for (let i = 0; i < 6; i++) {
    const x = head - i;
    if (x >= 0 && x < g.cols) cell(g, s, [x, y], "██", i === 0 ? "brightGreen" : "green", i === 5 ? "dim" : "");
  }
}

/** A message box in the middle of the field */
function panel(g, s, lines, color) {
  const w = Math.max(...lines.map((l) => [...l].length)) + 8;
  const h = lines.length + 2;
  const x = Math.floor((g.width - w) / 2);
  const y = 2 + Math.floor((g.rows - h) / 2);
  s.fill(x - 2, y - 1, w + 4, h + 2, " "); // a margin, so nothing under it touches the border
  s.box(x, y, w, h, color);
  // The heading is centered, the rest lines up on the left
  s.center(y + 1, lines[0], color, null, "bold");
  lines.slice(1).forEach((line, i) => s.text(x + 4, y + 2 + i, line, "white"));
}
