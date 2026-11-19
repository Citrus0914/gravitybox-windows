use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const ERROR_ALREADY_EXISTS: u32 = 183;
#[cfg(windows)]
const EVENT_MODIFY_STATE: u32 = 0x0002;
#[cfg(windows)]
const INFINITE: u32 = 0xFFFF_FFFF;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetUserDefaultLocaleName(lpLocaleName: *mut u16, cchLocaleName: i32) -> i32;
    fn CreateMutexW(
        lpMutexAttributes: *const c_void,
        bInitialOwner: i32,
        lpName: *const u16,
    ) -> *mut c_void;
    fn CreateEventW(
        lpEventAttributes: *const c_void,
        bManualReset: i32,
        bInitialState: i32,
        lpName: *const u16,
    ) -> *mut c_void;
    fn OpenEventW(dwDesiredAccess: u32, bInheritHandle: i32, lpName: *const u16) -> *mut c_void;
    fn SetEvent(hEvent: *mut c_void) -> i32;
    fn WaitForSingleObject(hHandle: *mut c_void, dwMilliseconds: u32) -> u32;
    fn CloseHandle(hObject: *mut c_void) -> i32;
    fn GetLastError() -> u32;
}

pub fn new_hidden_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub fn local_app_data_dir() -> PathBuf {
    if let Ok(val) = std::env::var("LOCALAPPDATA") {
        if !val.trim().is_empty() {
            return PathBuf::from(val);
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home).join("AppData").join("Local");
    }
    if let Ok(roaming) = std::env::var("APPDATA") {
        if let Some(app_data) = Path::new(&roaming).parent() {
            return app_data.join("Local");
        }
    }
    std::env::temp_dir().join("GravityBoxLocalAppData")
}

pub fn default_state_dir() -> PathBuf {
    local_app_data_dir().join("GravityBox")
}

pub fn default_antigravity_dir() -> PathBuf {
    local_app_data_dir().join("Programs").join("Antigravity")
}

pub fn default_antigravity_exe() -> PathBuf {
    default_antigravity_dir().join("Antigravity.exe")
}

fn normalize_path_for_node_resolve(path: &Path) -> String {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    let s = out.to_string_lossy().to_string();
    let trimmed = if s.len() > 3 && (s.ends_with('\\') || s.ends_with('/')) {
        s.trim_end_matches(&['\\', '/'][..]).to_string()
    } else {
        s
    };
    trimmed.to_lowercase()
}

pub fn state_dir_hash16(state_dir: &Path) -> String {
    let normalized = normalize_path_for_node_resolve(state_dir);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..16].to_string()
}

pub fn control_endpoint_for_state_dir(state_dir: &Path) -> String {
    format!("\\\\.\\pipe\\gravitybox-{}", state_dir_hash16(state_dir))
}

#[cfg(windows)]
fn to_wide_null(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
struct SendHandle(*mut c_void);

#[cfg(windows)]
unsafe impl Send for SendHandle {}
#[cfg(windows)]
unsafe impl Sync for SendHandle {}

pub struct SingleInstanceGuard {
    #[cfg(windows)]
    mutex_handle: SendHandle,
    #[cfg(windows)]
    wake_handle: SendHandle,
}

impl SingleInstanceGuard {
    pub fn acquire(state_dir: &Path, signal_existing: bool) -> Option<Self> {
        #[cfg(windows)]
        {
            let hash = state_dir_hash16(state_dir);
            let mutex_name = to_wide_null(&format!("Local\\GravityBox-Desktop-Mutex-{}", hash));
            let wake_name = to_wide_null(&format!("Local\\GravityBox-Desktop-Wake-{}", hash));

            unsafe {
                let mutex_handle = CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr());
                if !mutex_handle.is_null() && GetLastError() == ERROR_ALREADY_EXISTS {
                    CloseHandle(mutex_handle);
                    if signal_existing {
                        let ev = OpenEventW(EVENT_MODIFY_STATE, 0, wake_name.as_ptr());
                        if !ev.is_null() {
                            let _ = SetEvent(ev);
                            CloseHandle(ev);
                        }
                    }
                    return None;
                }
                let wake_handle = CreateEventW(std::ptr::null(), 0, 0, wake_name.as_ptr());
                Some(Self {
                    mutex_handle: SendHandle(mutex_handle),
                    wake_handle: SendHandle(wake_handle),
                })
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (state_dir, signal_existing);
            Some(Self {})
        }
    }

    pub fn wait_for_wake(&self) -> bool {
        #[cfg(windows)]
        {
            if self.wake_handle.0.is_null() {
                return false;
            }
            unsafe { WaitForSingleObject(self.wake_handle.0, INFINITE) == 0 }
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    pub fn signal_wake(&self) {
        #[cfg(windows)]
        {
            if !self.wake_handle.0.is_null() {
                unsafe {
                    let _ = SetEvent(self.wake_handle.0);
                }
            }
        }
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            if !self.wake_handle.0.is_null() {
                CloseHandle(self.wake_handle.0);
            }
            if !self.mutex_handle.0.is_null() {
                CloseHandle(self.mutex_handle.0);
            }
        }
    }
}

pub fn matches_antigravity_process_row(row: &Value, root_lower: &str) -> bool {
    let exe = row["exe"].as_str().unwrap_or("").to_lowercase();
    let cmd = row["cmd"]
        .as_str()
        .or_else(|| row["command"].as_str())
        .unwrap_or("")
        .to_lowercase();
    exe.starts_with(root_lower) || cmd.contains(root_lower)
}

pub fn get_system_locales() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut buf = [0u16; 85];
        let len = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
        if len > 1 {
            let locale = String::from_utf16_lossy(&buf[..(len as usize - 1)]);
            if !locale.trim().is_empty() {
                return vec![locale];
            }
        }
    }
    vec!["zh-CN".to_string()]
}

pub fn is_antigravity_running(helper_exe: Option<&Path>) -> bool {
    if let Some(helper) = helper_exe {
        if helper.exists() {
            if let Ok(output) = new_hidden_command(&helper.to_string_lossy())
                .arg("ps-list")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
            {
                if output.status.success() {
                    if let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout) {
                        let root = default_antigravity_dir().to_string_lossy().to_lowercase();
                        for row in &rows {
                            if matches_antigravity_process_row(row, &root) {
                                return true;
                            }
                        }
                        if rows.len() >= 10 {
                            return false;
                        }
                    }
                }
            }
        }
    }
    if let Ok(output) = new_hidden_command("tasklist.exe")
        .args(["/FI", "IMAGENAME eq Antigravity.exe", "/NH"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
        return text.contains("antigravity.exe");
    }
    false
}

pub fn build_antigravity_launch_command(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    cmd.arg("--remote-debugging-port=0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

pub fn launch_antigravity() -> Result<(), String> {
    let exe = default_antigravity_exe();
    if !exe.exists() {
        return Err(format!("Antigravity executable not found at {}", exe.display()));
    }
    build_antigravity_launch_command(&exe)
        .spawn()
        .map_err(|e| format!("Failed to launch Antigravity: {}", e))?;
    Ok(())
}

pub fn quit_antigravity_and_wait(helper_exe: Option<&Path>) -> Result<bool, String> {
    if !is_antigravity_running(helper_exe) {
        return Ok(true);
    }
    let _ = new_hidden_command("taskkill.exe")
        .args(["/IM", "Antigravity.exe"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let start = Instant::now();
    let mut retried = false;
    while start.elapsed() < Duration::from_secs(18) {
        if !is_antigravity_running(helper_exe) {
            thread::sleep(Duration::from_millis(350));
            return Ok(true);
        }
        if !retried && start.elapsed() >= Duration::from_secs(4) {
            retried = true;
            let _ = new_hidden_command("taskkill.exe")
                .args(["/IM", "Antigravity.exe", "/T"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        thread::sleep(Duration::from_millis(200));
    }
    Ok(!is_antigravity_running(helper_exe))
}

pub fn reveal_in_explorer(path: &Path) -> Result<(), String> {
    let mut cmd = Command::new("explorer.exe");
    if path.is_file() {
        cmd.arg(format!("/select,{}", path.display()));
    } else {
        cmd.arg(path);
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    Ok(())
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Unsupported URL scheme".to_string());
    }
    new_hidden_command("cmd.exe")
        .args(["/c", "start", "", url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to open browser: {}", e))?;
    Ok(())
}

const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "GravityBox";

pub fn get_auto_start() -> bool {
    if let Ok(output) = new_hidden_command("reg.exe")
        .args(["query", RUN_KEY, "/v", RUN_VALUE])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        return output.status.success();
    }
    false
}

pub fn set_auto_start(enabled: bool) -> Result<bool, String> {
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let val = format!("\"{}\" --minimized", exe.display());
        let status = new_hidden_command("reg.exe")
            .args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &val, "/f"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Failed to enable launch at login in Windows Registry".to_string());
        }
        Ok(true)
    } else {
        let _ = new_hidden_command("reg.exe")
            .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_endpoint_matches_node_backend_hash() {
        let endpoint = control_endpoint_for_state_dir(Path::new(
            r"C:\Users\demo\AppData\Local\GravityBox",
        ));
        assert_eq!(endpoint, r"\\.\pipe\gravitybox-02dcc6ae7162c645");
    }

    #[test]
    fn control_endpoint_normalizes_trailing_slash_and_case() {
        let a = control_endpoint_for_state_dir(Path::new(r"C:\Users\demo\AppData\Local\GravityBox\"));
        let b = control_endpoint_for_state_dir(Path::new(r"c:\users\demo\appdata\local\gravitybox"));
        assert_eq!(a, b);
    }

    #[test]
    fn matches_antigravity_process_row_reads_cmd_and_command() {
        let root = r"c:\users\demo\appdata\local\programs\antigravity";
        let row_cmd = serde_json::json!({
            "pid": 100,
            "exe": r"C:\Windows\System32\cmd.exe",
            "cmd": r"C:\Users\demo\AppData\Local\Programs\Antigravity\Antigravity.exe --type=renderer"
        });
        assert!(matches_antigravity_process_row(&row_cmd, root));

        let row_exe = serde_json::json!({
            "pid": 101,
            "exe": r"C:\Users\demo\AppData\Local\Programs\Antigravity\Antigravity.exe",
            "cmd": ""
        });
        assert!(matches_antigravity_process_row(&row_exe, root));

        let row_other = serde_json::json!({
            "pid": 102,
            "exe": r"C:\Windows\notepad.exe",
            "cmd": "notepad.exe"
        });
        assert!(!matches_antigravity_process_row(&row_other, root));
    }

    #[test]
    fn single_instance_guard_blocks_duplicate_and_signals_wake() {
        let dir1 = PathBuf::from(format!(
            r"C:\Users\demo\AppData\Local\GravityBox-UnitTest-{}-1",
            std::process::id()
        ));
        let dir2 = PathBuf::from(format!(
            r"C:\Users\demo\AppData\Local\GravityBox-UnitTest-{}-2",
            std::process::id()
        ));

        let guard1 = SingleInstanceGuard::acquire(&dir1, false).expect("first guard should succeed");
        assert!(SingleInstanceGuard::acquire(&dir1, true).is_none());
        assert!(guard1.wait_for_wake());

        let guard2 = SingleInstanceGuard::acquire(&dir2, false);
        assert!(guard2.is_some());

        drop(guard2);
        drop(guard1);

        let reacquired = SingleInstanceGuard::acquire(&dir1, false);
        assert!(reacquired.is_some());
    }

    #[test]
    fn antigravity_launch_command_enables_ephemeral_cdp_port() {
        let cmd = build_antigravity_launch_command(Path::new(r"C:\Demo\Antigravity.exe"));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["--remote-debugging-port=0"]);
    }
}
