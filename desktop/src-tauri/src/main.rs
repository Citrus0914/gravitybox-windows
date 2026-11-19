#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod config;
mod win_os;

use backend::BackendSupervisor;
use config::{load_config, save_config, AppConfig};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent,
};

struct AppState {
    backend: BackendSupervisor,
    config: Mutex<AppConfig>,
    quitting: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppRuntimeInfo {
    version: String,
    state_dir: String,
    pipe_endpoint: String,
    antigravity_dir: String,
    antigravity_installed: bool,
    antigravity_running: bool,
    system_locales: Vec<String>,
    auto_start: bool,
    core_found: bool,
    node_found: bool,
}

#[tauri::command]
fn ipc_request(state: State<AppState>, payload: Value) -> Result<Value, String> {
    if let Err(err) = ensure_backend_with_config(&state) {
        return Err(err);
    }
    state.backend.send_request(payload)
}

#[tauri::command]
fn restart_backend(state: State<AppState>) -> Result<bool, String> {
    state.backend.stop();
    ensure_backend_with_config(&state)?;
    Ok(true)
}

#[tauri::command]
fn load_app_config(state: State<AppState>) -> Result<AppConfig, String> {
    let cfg = load_config(&state.backend.state_dir)?;
    if let Ok(mut guard) = state.config.lock() {
        *guard = cfg.clone();
    }
    Ok(cfg)
}

#[tauri::command]
fn save_app_config(app: AppHandle, state: State<AppState>, patch: Value) -> Result<AppConfig, String> {
    let mut current = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    if let Some(obj) = patch.as_object() {
        let mut merged = serde_json::to_value(&current).map_err(|e| e.to_string())?;
        if let Some(m) = merged.as_object_mut() {
            for (k, v) in obj {
                m.insert(k.clone(), v.clone());
            }
        }
        current = serde_json::from_value(merged).map_err(|e| e.to_string())?;
    }

    let saved = save_config(&state.backend.state_dir, current)?;
    if let Ok(mut guard) = state.config.lock() {
        *guard = saved.clone();
    }
    let _ = app.emit("config-changed", &saved);
    Ok(saved)
}

#[tauri::command]
fn get_app_runtime_info(state: State<AppState>) -> AppRuntimeInfo {
    let ag_dir = win_os::default_antigravity_dir();
    let ag_exe = win_os::default_antigravity_exe();
    AppRuntimeInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        state_dir: state.backend.state_dir.to_string_lossy().to_string(),
        pipe_endpoint: state.backend.pipe_endpoint.clone(),
        antigravity_dir: ag_dir.to_string_lossy().to_string(),
        antigravity_installed: ag_exe.is_file(),
        antigravity_running: win_os::is_antigravity_running(state.backend.helper_exe.as_deref()),
        system_locales: win_os::get_system_locales(),
        auto_start: win_os::get_auto_start(),
        core_found: state.backend.core_entry.is_some(),
        node_found: state.backend.node_exe.is_some(),
    }
}

#[tauri::command]
fn set_auto_start(enabled: bool) -> Result<bool, String> {
    win_os::set_auto_start(enabled)
}

#[tauri::command]
fn launch_antigravity() -> Result<(), String> {
    win_os::launch_antigravity()
}

#[tauri::command]
fn quit_antigravity_and_wait(state: State<AppState>) -> Result<bool, String> {
    win_os::quit_antigravity_and_wait(state.backend.helper_exe.as_deref())
}

#[tauri::command]
fn reveal_state_dir(state: State<AppState>) -> Result<(), String> {
    win_os::reveal_in_explorer(&state.backend.state_dir)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    win_os::reveal_in_explorer(std::path::Path::new(&path))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    win_os::open_external_url(&url)
}

#[tauri::command]
fn open_main_window(app: AppHandle, page: Option<usize>) -> Result<(), String> {
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.unminimize();
        let _ = main_win.show();
        let _ = main_win.set_focus();
        if let Some(p) = page {
            let _ = main_win.emit("navigate-page", p);
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_tray_panel(app: AppHandle) {
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<AppState>) {
    state.quitting.store(true, Ordering::SeqCst);
    state.backend.stop();
    app.exit(0);
}

fn ensure_backend_with_config(state: &AppState) -> Result<(), String> {
    let locale = state
        .config
        .lock()
        .ok()
        .and_then(|c| c.app_language.clone());
    state.backend.ensure_started(locale.as_deref())
}

fn position_tray_window(
    tray_win: &tauri::WebviewWindow,
    icon_rect: tauri::Rect,
) {
    let Ok(win_size) = tray_win.outer_size() else {
        return;
    };
    let (icon_x, icon_y) = match icon_rect.position {
        tauri::Position::Physical(p) => (p.x, p.y),
        tauri::Position::Logical(p) => (p.x as i32, p.y as i32),
    };
    let (icon_w, icon_h) = match icon_rect.size {
        tauri::Size::Physical(s) => (s.width as i32, s.height as i32),
        tauri::Size::Logical(s) => (s.width as i32, s.height as i32),
    };

    let mut target_x = icon_x + icon_w / 2 - (win_size.width as i32) / 2;
    let mut target_y = icon_y - (win_size.height as i32) - 10;

    if let Ok(Some(monitor)) = tray_win.current_monitor() {
        let work = monitor.work_area();
        let min_x = work.position.x + 8;
        let max_x = work.position.x + work.size.width as i32 - win_size.width as i32 - 8;
        let min_y = work.position.y + 8;
        let max_y = work.position.y + work.size.height as i32 - win_size.height as i32 - 8;

        if target_y < min_y {
            target_y = icon_y + icon_h + 10;
        }
        target_x = target_x.clamp(min_x, max_x.max(min_x));
        target_y = target_y.clamp(min_y, max_y.max(min_y));
    } else if target_y < 8 {
        target_y = icon_y + icon_h + 10;
    }

    let _ = tray_win.set_position(PhysicalPosition::new(target_x, target_y));
}

fn toggle_tray_panel(app: &AppHandle, rect: tauri::Rect) {
    let Some(tray_win) = app.get_webview_window("tray") else {
        return;
    };
    let visible = tray_win.is_visible().unwrap_or(false);
    if visible {
        let _ = tray_win.hide();
    } else {
        let _ = tray_win.set_size(PhysicalSize::new(380, 580));
        position_tray_window(&tray_win, rect);
        let _ = tray_win.show();
        let _ = tray_win.set_focus();
        let _ = tray_win.emit("tray-opened", true);
    }
}

fn main() {
    let state_dir = std::env::var_os("GRAVITYBOX_STATE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(win_os::default_state_dir);
    let initial_config = load_config(&state_dir).unwrap_or_default();
    let minimized = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        .setup(move |app| {
            let res_dir = app.path().resource_dir().ok();
            let backend = BackendSupervisor::discover(state_dir.clone(), res_dir.as_deref());
            let app_state = AppState {
                backend,
                config: Mutex::new(initial_config.clone()),
                quitting: AtomicBool::new(false),
            };

            let app_handle = app.handle().clone();
            app.manage(app_state);

            // Start Node backend in background so window appears immediately
            std::thread::spawn(move || {
                let state = app_handle.state::<AppState>();
                let _ = ensure_backend_with_config(&state);
            });

            if minimized {
                if let Some(main_win) = app.get_webview_window("main") {
                    let _ = main_win.hide();
                }
            }

            // Build system tray icon & menu
            let open_item = MenuItem::with_id(app, "open_console", "打开控制台 / Open Console", true, None::<&str>)?;
            let launch_item = MenuItem::with_id(app, "launch_ag", "打开 Antigravity", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 / Quit GravityBox", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &launch_item, &quit_item])?;

            let icon_bytes = include_bytes!("../icons/32x32.png");
            let tray_icon = Image::from_bytes(icon_bytes).or_else(|_| {
                app.default_window_icon()
                    .cloned()
                    .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))
            })?;

            TrayIconBuilder::with_id("gravitybox-tray")
                .icon(tray_icon)
                .tooltip("GravityBox")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open_console" => {
                        let _ = open_main_window(app.clone(), None);
                    }
                    "launch_ag" => {
                        let _ = win_os::launch_antigravity();
                    }
                    "quit" => {
                        let state = app.state::<AppState>();
                        state.quitting.store(true, Ordering::SeqCst);
                        state.backend.stop();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_tray_panel(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            // Lifecycle watcher: optionally quit when Antigravity exits
            let watcher_handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut was_running = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    let state = watcher_handle.state::<AppState>();
                    if state.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    let sync_enabled = state
                        .config
                        .lock()
                        .map(|c| c.sync_antigravity_lifecycle)
                        .unwrap_or(false);
                    let running = win_os::is_antigravity_running(state.backend.helper_exe.as_deref());
                    if sync_enabled && was_running && !running {
                        state.quitting.store(true, Ordering::SeqCst);
                        state.backend.stop();
                        watcher_handle.exit(0);
                        break;
                    }
                    was_running = running;
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            if label == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let app = window.app_handle();
                    let quitting = app.state::<AppState>().quitting.load(Ordering::SeqCst);
                    if !quitting {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            } else if label == "tray" {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ipc_request,
            restart_backend,
            load_app_config,
            save_app_config,
            get_app_runtime_info,
            set_auto_start,
            launch_antigravity,
            quit_antigravity_and_wait,
            reveal_state_dir,
            reveal_path,
            open_external_url,
            open_main_window,
            hide_tray_panel,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GravityBox desktop");
}
