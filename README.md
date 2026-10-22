# Ascy

*Pronounced "ASK-ee", like ASCII.*

A hacker-style terminal emulator built with Tauri 2 (Rust) and xterm.js 6:
black background, phosphor-green text and an optional Matrix rain behind it.

> **Platform:** Linux only for now (the working directory of a shell is read
> from `/proc`, and only a `.deb` package is built).

## Features

- Tabs and split panes (nested, resizable with the mouse)
- Two themes: `hacker` and `night` (Tokyo Night style)
- Matrix rain background with an adjustable shade
- New tabs and panes open in the active shell's directory
- Scrollback search; URLs open with Ctrl+click
- Drag & drop a file to type its path into the shell
- JSON settings file, applied live without a restart
- ☰ menu: theme, matrix toggle, shade and font size sliders

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+Shift+T` / `W` | New tab / close pane |
| `Ctrl+PgUp` / `PgDn` | Previous / next tab |
| `Alt+1..9` | Jump to tab N |
| `Ctrl+Shift+E` / `O` | Split side by side / stacked |
| `Alt+←→↑↓` | Move between panes |
| `Ctrl+Shift+C` / `V` | Copy / paste |
| `Ctrl+Shift+F` | Search (Enter — next, Shift+Enter — previous, Esc — close) |
| `Ctrl` + `+` / `-` / `0` | Font bigger / smaller / reset |
| `Ctrl+Shift+M` | Toggle matrix rain |
| `Ctrl+Shift+P` | Switch theme (hacker ⇄ night) |
| `Ctrl+,` | Open the settings file in your default text editor |
| `Ctrl+Shift+R` | Reload settings |

## Settings

`~/.config/uz.otabek.ascy/settings.json` (created on first run):

```json
{
  "fontFamily": "\"JetBrains Mono\", \"Fira Code\", \"DejaVu Sans Mono\", monospace",
  "fontSize": 14,
  "theme": "hacker",
  "matrix": true,
  "shade": 0.28,
  "scrollback": 10000
}
```

| Key | Meaning |
|---|---|
| `fontFamily` | CSS font list |
| `fontSize` | Font size in px (8–28) |
| `theme` | `"hacker"` or `"night"` |
| `matrix` | Matrix rain background on/off |
| `shade` | How much the rain is dimmed: `0` (none) … `0.9` (almost black) |
| `scrollback` | Number of history lines kept per pane |

## Building

Requirements: Node.js, Rust ([rustup](https://rustup.rs)) and the
[Tauri prerequisites for Linux](https://v2.tauri.app/start/prerequisites/)
(`libwebkit2gtk-4.1-dev`, plus `librsvg2-dev` for packaging).

```bash
npm install               # first time only
npm run tauri dev         # development mode with hot reload
npm run tauri build       # release build + .deb package
```

The package lands in `src-tauri/target/release/bundle/deb/`.
Install with `sudo apt install ./Ascy_*.deb`, remove with `sudo apt remove ascy`.

## Project layout

```
src/                      # frontend (TypeScript)
  main.ts                 #   tabs, panes, shortcuts, menu, search
  theme.ts                #   themes (hacker, night)
  matrix.ts               #   Matrix rain (canvas)
  settings.ts             #   loading/saving settings
src-tauri/src/lib.rs      # backend (Rust): PTY sessions, settings commands
src-tauri/icons/icon.svg  # icon source (sizes generated with `npx tauri icon`)
```

## Technical notes

- xterm.js ignores alpha in the theme background, so in matrix mode the
  transparency comes from CSS (`body.matrix`) and the `#shade` overlay; the
  WebGL renderer is disabled in that mode (it comes back when matrix is off).
- Shell output is streamed to the webview as raw bytes over a Tauri channel
  with flow control: the frontend acknowledges what xterm.js has processed,
  and the backend stops reading from the PTY while more than 1 MiB is
  unacknowledged. A flood like `yes` slows the program down instead of
  freezing the window.
- The release build runs under a Content Security Policy: only the app's own
  scripts and Tauri IPC connections are allowed (inline styles too, since
  xterm.js creates `<style>` elements at runtime).
- The webview's clipboard API doesn't work in WebKitGTK, so
  `tauri-plugin-clipboard-manager` is used instead.

## License

[MIT](LICENSE)
