use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let mut windows = tauri_build::WindowsAttributes::new();
    let src_ico = PathBuf::from("icons/icon.ico");
    if src_ico.exists() {
        if let Ok(out_dir) = env::var("OUT_DIR") {
            let out_ico = PathBuf::from(out_dir).join("app-icon.ico");
            if fs::copy(&src_ico, &out_ico).is_ok() {
                windows = windows.window_icon_path(out_ico);
            }
        }
    }
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
