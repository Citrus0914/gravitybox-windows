use crate::win_os::{control_endpoint_for_state_dir, get_system_locales, new_hidden_command};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const MAX_REPLY_BYTES: usize = 4_000_000;

pub struct BackendSupervisor {
    pub state_dir: PathBuf,
    pub pipe_endpoint: String,
    pub core_entry: Option<PathBuf>,
    pub node_exe: Option<PathBuf>,
    pub helper_exe: Option<PathBuf>,
    child: Mutex<Option<Child>>,
    launch_lock: Mutex<()>,
}

impl BackendSupervisor {
    pub fn discover(state_dir: PathBuf, resource_dir: Option<&Path>) -> Self {
        let state_dir = strip_verbatim_prefix(state_dir);
        let pipe_endpoint = control_endpoint_for_state_dir(&state_dir);
        let clean_res = resource_dir.map(|p| strip_verbatim_prefix(p.to_path_buf()));
        let (node_exe, core_entry, helper_exe) = locate_runtime(clean_res.as_deref());
        Self {
            state_dir,
            pipe_endpoint,
            core_entry,
            node_exe,
            helper_exe,
            child: Mutex::new(None),
            launch_lock: Mutex::new(()),
        }
    }

    pub fn ensure_started(&self, preferred_locale: Option<&str>) -> Result<(), String> {
        let _guard = self.launch_lock.lock().map_err(|e| e.to_string())?;

        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                if let Ok(None) = child.try_wait() {
                    return Ok(());
                }
            }
        }

        // Check if an existing backend instance is already serving this pipe
        if self.ping_once().is_ok() {
            return Ok(());
        }

        let node = self
            .node_exe
            .as_ref()
            .ok_or_else(|| "Node.js runtime not found (expected runtime/node.exe or node in PATH)".to_string())?;
        let entry = self
            .core_entry
            .as_ref()
            .ok_or_else(|| "GravityBox core entrypoint dist/main.js not found".to_string())?;

        fs::create_dir_all(&self.state_dir).map_err(|e| e.to_string())?;
        let log_dir = self.state_dir.join("Logs");
        fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        let log_path = log_dir.join("backend.log");
        if let Ok(meta) = fs::metadata(&log_path) {
            if meta.len() > 1_048_576 {
                let _ = fs::rename(&log_path, log_dir.join("backend-prev.log"));
            }
        }
        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("Failed to open backend log: {}", e))?;

        let mut cmd = new_hidden_command(&node.to_string_lossy());
        cmd.arg("--max-old-space-size=256")
            .arg(entry)
            .arg("--state-dir")
            .arg(&self.state_dir)
            .env("GRAVITYBOX_CONTROL_ENDPOINT", &self.pipe_endpoint)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log_file));

        if let Some(loc) = preferred_locale {
            let trimmed = loc.trim();
            if !trimmed.is_empty() {
                cmd.args(["--locale", trimmed]);
            }
        }
        let sys_locales = get_system_locales();
        if !sys_locales.is_empty() {
            cmd.args(["--system-locales", &sys_locales.join(",")]);
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start GravityBox backend: {}", e))?;

        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }
        Ok(())
    }

    pub fn ping_once(&self) -> Result<Value, String> {
        self.perform_raw_request(&serde_json::json!({ "command": "ping" }))
    }

    pub fn send_request(&self, payload: Value) -> Result<Value, String> {
        let mut last_err = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        for attempt in 0..24 {
            match self.perform_raw_request(&payload) {
                Ok(val) => return Ok(val),
                Err(err) => {
                    last_err = err.clone();
                    let retryable = err.contains("PIPE_WAIT")
                        || err.contains("PIPE_NOT_READY")
                        || err.contains("os error 2)")
                        || err.contains("os error 231)");
                    if !retryable || Instant::now() >= deadline || attempt == 23 {
                        break;
                    }
                    let delay_ms = (80 + (attempt as u64) * 35).min(300);
                    thread::sleep(Duration::from_millis(delay_ms));
                }
            }
        }
        Err(last_err)
    }

    fn perform_raw_request(&self, payload: &Value) -> Result<Value, String> {
        let mut pipe = match OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.pipe_endpoint)
        {
            Ok(f) => f,
            Err(e) => {
                let code = e.raw_os_error().unwrap_or(0);
                if code == 231 {
                    return Err(format!("PIPE_WAIT: {}", e));
                }
                if code == 2 {
                    return Err(format!("PIPE_NOT_READY: {}", e));
                }
                return Err(format!("Cannot connect to backend service: {}", e));
            }
        };

        let mut encoded = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        pipe.write_all(&encoded)
            .map_err(|e| format!("Failed to write IPC request: {}", e))?;
        pipe.flush()
            .map_err(|e| format!("Failed to flush IPC request: {}", e))?;

        let mut reader = BufReader::new(pipe);
        let mut line = Vec::with_capacity(4096);
        let bytes_read = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("Failed to read IPC reply: {}", e))?;
        if bytes_read == 0 {
            return Err("Backend closed IPC connection unexpectedly".to_string());
        }
        if line.len() > MAX_REPLY_BYTES {
            return Err("Backend reply exceeded 4MB limit".to_string());
        }
        let value: Value = serde_json::from_slice(&line)
            .map_err(|e| format!("Invalid JSON reply from backend: {}", e))?;
        if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            let is_partial_accounts = value.get("partial").and_then(|v| v.as_bool()) == Some(true)
                && value.get("accounts").and_then(|v| v.as_array()).is_some();
            if is_partial_accounts {
                return Ok(value);
            }
            let failure_msg = value
                .get("failures")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    if arr.is_empty() {
                        None
                    } else {
                        arr[0]
                            .get("error")
                            .or_else(|| arr[0].get("message"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| Some(format!("{} account refresh failure(s)", arr.len())))
                    }
                });
            let msg = value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or(failure_msg)
                .unwrap_or_else(|| "Operation incomplete".to_string());
            return Err(msg);
        }
        Ok(value)
    }

    pub fn stop(&self) {
        let _ = self.perform_raw_request(&serde_json::json!({ "command": "stop" }));
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let wait_until = Instant::now() + Duration::from_secs(2);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if Instant::now() < wait_until => {
                            thread::sleep(Duration::from_millis(50));
                        }
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                    }
                }
            }
        }
    }
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn locate_runtime(resource_dir: Option<&Path>) -> (Option<PathBuf>, Option<PathBuf>, Option<PathBuf>) {
    let mut candidate_roots: Vec<PathBuf> = Vec::new();
    if let Some(res) = resource_dir {
        candidate_roots.push(strip_verbatim_prefix(res.to_path_buf()));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidate_roots.push(strip_verbatim_prefix(parent.to_path_buf()));
        }
    }
    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        let p = PathBuf::from(manifest_dir);
        if let Some(desktop_dir) = p.parent() {
            if let Some(repo_root) = desktop_dir.parent() {
                candidate_roots.push(repo_root.to_path_buf());
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut cur = Some(cwd.as_path());
        for _ in 0..5 {
            if let Some(dir) = cur {
                candidate_roots.push(dir.to_path_buf());
                cur = dir.parent();
            }
        }
    }

    let mut core_entry = std::env::var_os("GRAVITYBOX_CORE_ENTRY")
        .map(PathBuf::from)
        .filter(|p| p.is_file());
    let mut node_exe = std::env::var_os("GRAVITYBOX_NODE_EXE")
        .map(PathBuf::from)
        .filter(|p| p.is_file());
    let mut helper_exe = None;

    for root in &candidate_roots {
        if core_entry.is_none() {
            for rel in ["core/dist/main.js", "dist/main.js"] {
                let candidate = root.join(rel);
                if candidate.is_file() {
                    core_entry = Some(candidate);
                    break;
                }
            }
        }
        if node_exe.is_none() {
            let bundled = root.join("runtime").join("node.exe");
            if bundled.is_file() {
                node_exe = Some(bundled);
            }
        }
        if helper_exe.is_none() {
            for rel in ["core/dist/gb-win-helper.exe", "dist/gb-win-helper.exe", "gb-win-helper.exe"] {
                let candidate = root.join(rel);
                if candidate.is_file() {
                    helper_exe = Some(candidate);
                    break;
                }
            }
        }
    }

    if node_exe.is_none() {
        node_exe = find_in_path("node.exe");
    }

    (
        node_exe.map(strip_verbatim_prefix),
        core_entry.map(strip_verbatim_prefix),
        helper_exe.map(strip_verbatim_prefix),
    )
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::strip_verbatim_prefix;
    use std::path::PathBuf;

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_prefix_handles_drive_and_unc_paths() {
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\C:\Users\Demo\GravityBox")),
            PathBuf::from(r"C:\Users\Demo\GravityBox")
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\dir")),
            PathBuf::from(r"\\server\share\dir")
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"C:\Normal\Path")),
            PathBuf::from(r"C:\Normal\Path")
        );
    }
}
