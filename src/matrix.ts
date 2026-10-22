/** Classic "Matrix rain" — green glyphs falling on a canvas behind the terminal. */
export class MatrixRain {
  private ctx: CanvasRenderingContext2D;
  private drops: number[] = [];
  private raf = 0;
  private last = 0;
  private running = false;
  private readonly fontSize = 16;
  private readonly glyphs =
    "アィウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ0123456789$+*=%#@&<>";

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    window.addEventListener("resize", () => this.running && this.resize());
    // Pause the animation while the window is hidden so it doesn't waste CPU
    document.addEventListener("visibilitychange", () => {
      if (!this.running) return;
      cancelAnimationFrame(this.raf);
      if (!document.hidden) this.loop();
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.canvas.style.display = "block";
    this.resize();
    this.loop();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.canvas.style.display = "none";
  }

  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    const cols = Math.ceil(this.canvas.width / this.fontSize);
    this.drops = Array.from(
      { length: cols },
      () => -Math.floor(Math.random() * 60),
    );
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.last < 55) return; // ~18 FPS — smooth and cheap
    this.last = now;
    this.step();
  };

  private step() {
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    // A translucent black layer every frame — old glyphs slowly fade, leaving a "tail"
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.fillRect(0, 0, width, height);
    ctx.font = `${this.fontSize}px monospace`;
    for (let i = 0; i < this.drops.length; i++) {
      const y = this.drops[i] * this.fontSize;
      if (y > 0) {
        const ch = this.glyphs[Math.floor(Math.random() * this.glyphs.length)];
        ctx.fillStyle = Math.random() > 0.97 ? "#b4ffc8" : "#00cc33";
        ctx.fillText(ch, i * this.fontSize, y);
      }
      if (y > height && Math.random() > 0.975) this.drops[i] = 0;
      else this.drops[i]++;
    }
  }
}
