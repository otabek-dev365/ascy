use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pid: Option<u32>,
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

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
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

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let pid = child.process_id();
    let session = Arc::new(PtySession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        pid,
    });
    state.0.lock().unwrap().insert(id.clone(), session.clone());

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // A UTF-8 character may be split across two reads — the incomplete
        // tail bytes are kept in `carry` until the next read.
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let (text, rest) = match std::str::from_utf8(&carry) {
                        Ok(s) => (s.to_owned(), Vec::new()),
                        Err(e) if e.error_len().is_none() => {
                            let valid = e.valid_up_to();
                            (
                                String::from_utf8_lossy(&carry[..valid]).into_owned(),
                                carry[valid..].to_vec(),
                            )
                        }
                        Err(_) => (String::from_utf8_lossy(&carry).into_owned(), Vec::new()),
                    };
                    if !text.is_empty() {
                        let _ = app.emit(&format!("pty-output-{id}"), text);
                    }
                    carry = rest;
                }
            }
        }
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
    let mut writer = session.writer.lock().unwrap();
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let session = get_session(&state, &id)?;
    let master = session.master.lock().unwrap();
    master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    if let Some(session) = state.0.lock().unwrap().remove(&id) {
        let _ = session.child.lock().unwrap().kill();
    }
    Ok(())
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

#[tauri::command]
fn pty_kill_all(state: State<PtyState>) -> Result<(), String> {
    let sessions: Vec<_> = state.0.lock().unwrap().drain().collect();
    for (_, session) in sessions {
        let _ = session.child.lock().unwrap().kill();
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
    Ok(Some(serde_json::from_str(&text).map_err(|e| e.to_string())?))
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
            pty_resize,
            pty_kill,
            pty_kill_all,
            pty_cwd,
            settings_load,
            settings_save,
            settings_open
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
