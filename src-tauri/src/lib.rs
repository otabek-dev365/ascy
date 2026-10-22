use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::RawFd;
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
            settings_save,
            settings_open
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
