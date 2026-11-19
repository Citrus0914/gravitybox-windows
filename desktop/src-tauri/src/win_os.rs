use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetUserDefaultLocaleName(lpLocaleName: *mut u16, cchLocaleName: i32) -> i32;
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

pub fn control_endpoint_for_state_dir(state_dir: &Path) -> String {
    let normalized = normalize_path_for_node_resolve(state_dir);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("\\\\.\\pipe\\gravitybox-{}", &digest[..16])
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
                        for row in rows {
                            let exe = row["exe"].as_str().unwrap_or("").to_lowercase();
                            let cmd = row["command"].as_str().unwrap_or("").to_lowercase();
                            if exe.starts_with(&root) || cmd.contains(&root) {
                                return true;
                            }
                        }
                        return false;
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

pub fn launch_antigravity() -> Result<(), String> {
    let exe = default_antigravity_exe();
    if !exe.exists() {
        return Err(format!("Antigravity executable not found at {}", exe.display()));
    }
    Command::new(&exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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
}
