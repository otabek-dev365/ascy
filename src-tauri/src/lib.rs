use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::RawFd;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

// Output flow control: the reader stops reading from the PTY while too much
// output is still waiting for xterm.js, so a flood (`yes`, a huge `cat`)
// blocks the program instead of piling up in the webview's memory.
/// Pause reading once this many bytes are unacknowledged...
const FLOW_HIGH: usize = 1 << 20;
/// ...and resume when the frontend has caught up to this
const FLOW_LOW: usize = 256 << 10;
/// Largest output chunk sent to the frontend in one message
const CHUNK: usize = 64 << 10;

#[derive(Default)]
struct Flow {
    /// Bytes sent to the frontend but not yet processed by xterm.js
    unacked: usize,
    /// Set when the session is killed, so a paused reader can finish
    closed: bool,
}

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Input goes through a writer thread: a blocking write (e.g. a big paste
    /// into a program that isn't reading) must never stall the main thread
    input: Sender<Vec<u8>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pid: Option<u32>,
    flow: Mutex<Flow>,
    flow_cv: Condvar,
}

impl PtySession {
    fn kill(&self) {
        self.flow.lock().unwrap().closed = true;
        self.flow_cv.notify_one();
        // Hang up the program in the foreground (vim, ssh, …) as a real terminal
        // hangup would — the shell alone doesn't always pass SIGHUP on
        let group = self.master.lock().unwrap().process_group_leader();
        if let Some(group) = group.filter(|&g| Some(g as u32) != self.pid) {
            // SAFETY: plain signal send to a process group id read from the pty
            unsafe { libc::killpg(group, libc::SIGHUP) };
        }
        let _ = self.child.lock().unwrap().kill();
    }
}

#[derive(Default)]
struct PtyState(Mutex<HashMap<String, Arc<PtySession>>>);

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// True if the PTY has more output ready right now (poll with zero timeout)
fn has_more_output(fd: RawFd) -> bool {
    let mut pfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: a single valid pollfd and a zero timeout
    unsafe { libc::poll(&mut pfd, 1, 0) == 1 && pfd.revents & libc::POLLIN != 0 }
}

/// UTF-8 aware line editing: in cooked mode (`read`, `cat`) Backspace erases a
/// whole multi-byte character instead of just its last byte
fn enable_iutf8(fd: RawFd) {
    // SAFETY: termios is plain data, filled in by tcgetattr on a valid pty fd
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut t) == 0 {
            t.c_iflag |= libc::IUTF8;
            libc::tcsetattr(fd, libc::TCSANOW, &t);
        }
    }
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let start_dir = cwd
        .filter(|d| std::path::Path::new(d).is_dir())
        .or_else(|| std::env::var("HOME").ok());
    if let Some(dir) = start_dir {
        cmd.cwd(dir);
    }

    let fd = pair.master.as_raw_fd();
    if let Some(fd) = fd {
        enable_iutf8(fd);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let (input, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in input_rx {
            if writer.write_all(&data).is_err() {
                break;
            }
        }
    });

    let pid = child.process_id();
    let session = Arc::new(PtySession {
        master: Mutex::new(pair.master),
        input,
        child: Mutex::new(child),
        pid,
        flow: Mutex::default(),
        flow_cv: Condvar::new(),
    });
    state.0.lock().unwrap().insert(id.clone(), session.clone());

    std::thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        loop {
            let mut len = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            // Under heavy output, also take what is already waiting: fewer and
            // bigger messages, while interactive echo still goes out at once
            while len < CHUNK && fd.is_some_and(has_more_output) {
                match reader.read(&mut buf[len..]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => len += n,
                }
            }
            // Raw bytes: xterm.js decodes UTF-8 itself, even when a character
            // is split between two messages
            let _ = output.send(InvokeResponseBody::Raw(buf[..len].to_vec()));

            let mut flow = session.flow.lock().unwrap();
            flow.unacked += len;
            if flow.unacked > FLOW_HIGH {
                while flow.unacked > FLOW_LOW && !flow.closed {
                    flow = session.flow_cv.wait(flow).unwrap();
                }
            }
        }
        // Reap the shell so it doesn't linger as a zombie
        let _ = session.child.lock().unwrap().wait();
        let _ = app.emit(&format!("pty-exit-{id}"), ());
        // Remove only THIS session from the map — if the id was reused
        // (e.g. after a page reload), leave the new session alone.
        let state = app.state::<PtyState>();
        let mut map = state.0.lock().unwrap();
        if map.get(&id).is_some_and(|cur| Arc::ptr_eq(cur, &session)) {
            map.remove(&id);
        }
    });

    Ok(())
}

fn get_session(state: &State<PtyState>, id: &str) -> Result<Arc<PtySession>, String> {
    state
        .0
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("PTY session not found: {id}"))
}

#[tauri::command]
fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let session = get_session(&state, &id)?;
    session
        .input
        .send(data.into_bytes())
        .map_err(|e| e.to_string())
}

/// Raw bytes from xterm's onBinary (old-style mouse reports aren't valid UTF-8)
#[tauri::command]
fn pty_write_bytes(state: State<PtyState>, id: String, data: Vec<u8>) -> Result<(), String> {
    let session = get_session(&state, &id)?;
    session.input.send(data).map_err(|e| e.to_string())
}

/// The frontend reports how many output bytes xterm.js has processed
#[tauri::command]
fn pty_ack(state: State<PtyState>, id: String, bytes: usize) {
    // A late ack for a session that already exited is simply dropped
    let session = state.0.lock().unwrap().get(&id).cloned();
    if let Some(session) = session {
        let mut flow = session.flow.lock().unwrap();
        flow.unacked = flow.unacked.saturating_sub(bytes);
        session.flow_cv.notify_one();
    }
}

#[tauri::command]
fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let session = get_session(&state, &id)?;
    let master = session.master.lock().unwrap();
    master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

// async: killing waits up to ~250 ms for the shell to exit — keep that off the main thread
#[tauri::command(async)]
fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    let session = state.0.lock().unwrap().remove(&id);
    if let Some(session) = session {
        session.kill();
    }
    Ok(())
}

/// The program in the foreground of the pane, unless it's the shell itself:
/// closing the pane would kill it (vim, ssh, a running build, …)
#[tauri::command]
fn pty_foreground(state: State<PtyState>, id: String) -> Result<Option<String>, String> {
    let session = get_session(&state, &id)?;
    let group = session.master.lock().unwrap().process_group_leader();
    Ok(match (group, session.pid) {
        (Some(group), Some(shell)) if group as u32 != shell => {
            std::fs::read_to_string(format!("/proc/{group}/comm"))
                .ok()
                .map(|name| name.trim().to_owned())
        }
        _ => None,
    })
}

/// The shell's current directory — so a new tab/pane opens in the same place
#[tauri::command]
fn pty_cwd(state: State<PtyState>, id: String) -> Result<Option<String>, String> {
    let session = get_session(&state, &id)?;
    Ok(session
        .pid
        .and_then(|pid| std::fs::read_link(format!("/proc/{pid}/cwd")).ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command(async)]
fn pty_kill_all(state: State<PtyState>) -> Result<(), String> {
    let sessions: Vec<_> = state.0.lock().unwrap().drain().collect();
    for (_, session) in sessions {
        session.kill();
    }
    Ok(())
}

fn settings_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn session_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

/// The tabs of the last run, reopened on start
#[tauri::command]
fn session_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let Ok(text) = std::fs::read_to_string(session_file(&app)?) else {
        return Ok(None);
    };
    // A damaged session file just means starting fresh
    Ok(serde_json::from_str(&text).ok())
}

#[tauri::command]
fn session_save(app: AppHandle, session: serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    write_atomic(&session_file(&app)?, &text)
}

/// Writes a temp file and renames it, so a crash mid-write can't leave half a file
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ---------- Arcade: games installed by the user and their saved data ----------

const GAME_MANIFEST_LIMIT: u64 = 64 * 1024;
const GAME_SOURCE_LIMIT: u64 = 4 * 1024 * 1024;
const GAME_DATA_LIMIT: usize = 256 * 1024;
const GAME_INSTALL_BYTES: u64 = 16 * 1024 * 1024;
const GAME_INSTALL_FILES: usize = 500;

fn games_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("games"))
}

/// Game ids double as folder and file names, so they stay within a safe
/// alphabet. The "ascy." prefix belongs to the built-in games.
fn valid_game_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "-_.".contains(c))
}

fn game_data_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_game_id(id) {
        return Err(format!("invalid game id: {id}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("game-data").join(format!("{id}.json")))
}

fn read_limited(path: &Path, limit: u64) -> Result<String, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let meta = std::fs::metadata(path).map_err(|_| format!("{name} not found"))?;
    if meta.len() > limit {
        return Err(format!("{name} is larger than {} KiB", limit / 1024));
    }
    std::fs::read_to_string(path).map_err(|e| format!("{name}: {e}"))
}

fn read_manifest(dir: &Path) -> Result<serde_json::Value, String> {
    let text = read_limited(&dir.join("game.json"), GAME_MANIFEST_LIMIT)?;
    let manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("game.json: {e}"))?;
    if !manifest.is_object() {
        return Err("game.json must be a JSON object".into());
    }
    Ok(manifest)
}

#[derive(serde::Serialize)]
struct InstalledGame {
    id: String,
    manifest: Option<serde_json::Value>,
    error: Option<String>,
}

/// The games folder: one subfolder per game, each with a game.json
#[tauri::command]
fn games_list(app: AppHandle) -> Result<Vec<InstalledGame>, String> {
    let Ok(entries) = std::fs::read_dir(games_dir(&app)?) else {
        return Ok(Vec::new());
    };
    let mut games = Vec::new();
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        // Hidden entries include half-finished installs
        if id.starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        let checked = if !valid_game_id(&id) || id.starts_with("ascy.") {
            Err("rename the folder: lowercase letters, digits, '-', '_' and '.' only".to_owned())
        } else {
            read_manifest(&entry.path())
        };
        games.push(match checked {
            Ok(manifest) => InstalledGame {
                id,
                manifest: Some(manifest),
                error: None,
            },
            Err(error) => InstalledGame {
                id,
                manifest: None,
                error: Some(error),
            },
        });
    }
    games.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(games)
}

/// The code of an installed game: its "main" file, main.js by default
#[tauri::command]
fn game_source(app: AppHandle, id: String) -> Result<String, String> {
    if !valid_game_id(&id) || id.starts_with("ascy.") {
        return Err(format!("invalid game id: {id}"));
    }
    let dir = games_dir(&app)?.join(&id);
    let manifest = read_manifest(&dir)?;
    let main = manifest
        .get("main")
        .and_then(|m| m.as_str())
        .unwrap_or("main.js");
    // The file must stay inside the game's folder: no "../", no symlinks out
    let base = dir.canonicalize().map_err(|e| e.to_string())?;
    let file = base
        .join(main)
        .canonicalize()
        .map_err(|_| format!("{main} not found"))?;
    if !file.starts_with(&base) {
        return Err(format!("{main} is outside the game folder"));
    }
    read_limited(&file, GAME_SOURCE_LIMIT)
}

/// A game's saved data (best score, ascy.storage); built-in games included
#[tauri::command]
fn game_data_load(app: AppHandle, id: String) -> Result<Option<serde_json::Value>, String> {
    let Ok(text) = std::fs::read_to_string(game_data_file(&app, &id)?) else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&text).ok())
}

#[tauri::command]
fn game_data_save(app: AppHandle, id: String, data: serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    if text.len() > GAME_DATA_LIMIT {
        return Err(format!(
            "saved data is larger than {} KiB",
            GAME_DATA_LIMIT / 1024
        ));
    }
    write_atomic(&game_data_file(&app, &id)?, &text)
}

#[tauri::command]
fn games_open_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = games_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Copies a game folder (dropped on the game list) into the games folder and
/// returns the game's id. A game with the same id is replaced (an update).
#[tauri::command]
fn game_install(app: AppHandle, path: String) -> Result<String, String> {
    let mut src = PathBuf::from(path);
    if src.file_name().is_some_and(|n| n == "game.json") {
        src.pop();
    }
    if !src.is_dir() {
        return Err("drop a game folder (one that has a game.json)".into());
    }
    read_manifest(&src)?;
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut id: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || "-_.".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    id = id.trim_matches(|c| c == '-' || c == '.').to_owned();
    if id.starts_with("ascy.") {
        id = format!("my-{id}");
    }
    if !valid_game_id(&id) {
        return Err(format!("can't make a game id from \"{name}\""));
    }
    let games = games_dir(&app)?;
    std::fs::create_dir_all(&games).map_err(|e| e.to_string())?;
    // Copy next to the target first, then swap: a failed copy leaves no half game
    let tmp = games.join(format!(".installing-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    let mut budget = (GAME_INSTALL_BYTES, GAME_INSTALL_FILES);
    if let Err(e) = copy_game_files(&src, &tmp, &mut budget) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let dest = games.join(&id);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Copies files and folders within a size budget; hidden entries (.git, …)
/// and symlinks are left out
fn copy_game_files(src: &Path, dst: &Path, budget: &mut (u64, usize)) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            copy_game_files(&entry.path(), &to, budget)?;
        } else if kind.is_file() {
            let len = entry.metadata().map_err(|e| e.to_string())?.len();
            if budget.1 == 0 || len > budget.0 {
                return Err("the game folder is too big (16 MiB and 500 files at most)".into());
            }
            budget.0 -= len;
            budget.1 -= 1;
            std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn settings_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = settings_file(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("expected a JSON object".into());
    }
    Ok(Some(value))
}

#[tauri::command]
fn settings_save(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = settings_file(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_open(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = settings_file(&app)?;
    // `.json` usually belongs to the web browser (and a snap Firefox can't even
    // read ~/.config), so prefer the default text editor
    #[cfg(target_os = "linux")]
    {
        use gio::prelude::*;
        if let Some(editor) = gio::AppInfo::default_for_type("text/plain", false) {
            let file = gio::File::for_path(&path);
            if editor
                .launch(&[file], None::<&gio::AppLaunchContext>)
                .is_ok()
            {
                return Ok(());
            }
        }
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_write_bytes,
            pty_ack,
            pty_resize,
            pty_kill,
            pty_kill_all,
            pty_cwd,
            pty_foreground,
            settings_load,
            session_load,
            session_save,
            settings_save,
            settings_open,
            games_list,
            game_source,
            game_data_load,
            game_data_save,
            games_open_folder,
            game_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
