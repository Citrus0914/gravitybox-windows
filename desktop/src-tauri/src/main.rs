#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod config;
mod win_os;

use backend::BackendSupervisor;
use config::{load_config, save_config, AppConfig};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, State, WindowEvent,
};
use win_os::SingleInstanceGuard;

struct AppState {
    backend: Arc<BackendSupervisor>,
    config: Arc<Mutex<AppConfig>>,
    quitting: Arc<AtomicBool>,
    cleanup_started: AtomicBool,
    last_tray_blur: Mutex<Option<Instant>>,
    instance_guard: Option<Arc<SingleInstanceGuard>>,
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
async fn ipc_request(state: State<'_, AppState>, payload: Value) -> Result<Value, String> {
    let backend = Arc::clone(&state.backend);
    let config = Arc::clone(&state.config);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_backend_with_config(&backend, &config)?;
        backend.send_request(payload)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn restart_backend(state: State<'_, AppState>) -> Result<bool, String> {
    let backend = Arc::clone(&state.backend);
    let config = Arc::clone(&state.config);
    tauri::async_runtime::spawn_blocking(move || {
        backend.stop();
        ensure_backend_with_config(&backend, &config)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_app_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    let state_dir = state.backend.state_dir.clone();
    let config_arc = Arc::clone(&state.config);
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config(&state_dir)?;
        if let Ok(mut guard) = config_arc.lock() {
            *guard = cfg.clone();
        }
        Ok(cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_app_config(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: Value,
) -> Result<AppConfig, String> {
    let state_dir = state.backend.state_dir.clone();
    let config_arc = Arc::clone(&state.config);
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let mut current = config_arc.lock().map_err(|e| e.to_string())?.clone();
        if let Some(obj) = patch.as_object() {
            let mut merged = serde_json::to_value(&current).map_err(|e| e.to_string())?;
            if let Some(m) = merged.as_object_mut() {
                for (k, v) in obj {
                    m.insert(k.clone(), v.clone());
                }
            }
            current = serde_json::from_value(merged).map_err(|e| e.to_string())?;
        }
        let saved = save_config(&state_dir, current)?;
        if let Ok(mut guard) = config_arc.lock() {
            *guard = saved.clone();
        }
        Ok::<AppConfig, String>(saved)
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit("config-changed", &saved);
    Ok(saved)
}

#[tauri::command]
async fn get_app_runtime_info(state: State<'_, AppState>) -> Result<AppRuntimeInfo, String> {
    let backend = Arc::clone(&state.backend);
    tauri::async_runtime::spawn_blocking(move || {
        let ag_dir = win_os::default_antigravity_dir();
        let ag_exe = win_os::default_antigravity_exe();
        AppRuntimeInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            state_dir: backend.state_dir.to_string_lossy().to_string(),
            pipe_endpoint: backend.pipe_endpoint.clone(),
            antigravity_dir: ag_dir.to_string_lossy().to_string(),
            antigravity_installed: ag_exe.is_file(),
            antigravity_running: win_os::is_antigravity_running(backend.helper_exe.as_deref()),
            system_locales: win_os::get_system_locales(),
            auto_start: win_os::get_auto_start(),
            core_found: backend.core_entry.is_some(),
            node_found: backend.node_exe.is_some(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_auto_start(enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || win_os::set_auto_start(enabled))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn launch_antigravity() -> Result<(), String> {
    win_os::launch_antigravity()
}

#[tauri::command]
async fn quit_antigravity_and_wait(state: State<'_, AppState>) -> Result<bool, String> {
    let helper_exe = state.backend.helper_exe.clone();
    tauri::async_runtime::spawn_blocking(move || {
        win_os::quit_antigravity_and_wait(helper_exe.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileResult {
    saved: bool,
    cancelled: bool,
    path: Option<String>,
}

#[tauri::command]
async fn save_json_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    default_name: String,
    content: String,
    title: Option<String>,
    filter_label: Option<String>,
    all_files_label: Option<String>,
) -> Result<SaveFileResult, String> {
    #[cfg(windows)]
    let owner_hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let owner_hwnd: isize = {
        let _ = &window;
        0
    };

    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<Option<std::path::PathBuf>, String>>(1);
    app.run_on_main_thread(move || {
        let res = win_os::pick_save_json_path(
            owner_hwnd,
            &default_name,
            title.as_deref(),
            filter_label.as_deref(),
            all_files_label.as_deref(),
        );
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;

    let chosen = tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|e| format!("Save dialog channel closed: {}", e))?
    })
    .await
    .map_err(|e| e.to_string())??;

    let Some(path) = chosen else {
        return Ok(SaveFileResult {
            saved: false,
            cancelled: true,
            path: None,
        });
    };

    let write_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&write_path, content.as_bytes()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(SaveFileResult {
        saved: true,
        cancelled: false,
        path: Some(path.to_string_lossy().to_string()),
    })
}

fn show_main_window(app: &AppHandle, page: Option<usize>) {
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
}

#[tauri::command]
fn open_main_window(app: AppHandle, page: Option<usize>) -> Result<(), String> {
    show_main_window(&app, page);
    Ok(())
}

#[tauri::command]
fn hide_tray_panel(app: AppHandle) {
    if let Some(tray) = app.get_webview_window("tray") {
        let _ = tray.hide();
    }
}

fn perform_cleanup(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.quitting.store(true, Ordering::SeqCst);
    if !state.cleanup_started.swap(true, Ordering::SeqCst) {
        if let Some(guard) = &state.instance_guard {
            guard.signal_wake();
        }
        state.backend.stop();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    perform_cleanup(&app);
    app.exit(0);
}

fn ensure_backend_with_config(
    backend: &BackendSupervisor,
    config: &Mutex<AppConfig>,
) -> Result<(), String> {
    let locale = config.lock().ok().and_then(|c| c.app_language.clone());
    backend.ensure_started(locale.as_deref())
}

fn find_monitor_for_rect(
    tray_win: &tauri::WebviewWindow,
    icon_rect: &tauri::Rect,
) -> Option<tauri::Monitor> {
    if let Ok(monitors) = tray_win.available_monitors() {
        let primary_scale = tray_win
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);
        let pos = icon_rect.position.to_physical::<i32>(primary_scale);
        let size = icon_rect.size.to_physical::<u32>(primary_scale);
        let cx = pos.x + (size.width as i32) / 2;
        let cy = pos.y + (size.height as i32) / 2;

        for m in monitors {
            let m_pos = m.position();
            let m_size = m.size();
            if cx >= m_pos.x
                && cx < m_pos.x + m_size.width as i32
                && cy >= m_pos.y
                && cy < m_pos.y + m_size.height as i32
            {
                return Some(m);
            }
        }
    }
    tray_win
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| tray_win.current_monitor().ok().flatten())
}

fn position_tray_window(tray_win: &tauri::WebviewWindow, icon_rect: tauri::Rect) {
    let Some(monitor) = find_monitor_for_rect(tray_win, &icon_rect) else {
        return;
    };
    let scale = monitor.scale_factor();
    let icon_pos = icon_rect.position.to_physical::<i32>(scale);
    let icon_size = icon_rect.size.to_physical::<u32>(scale);
    let win_size = LogicalSize::new(380.0_f64, 580.0_f64).to_physical::<u32>(scale);

    let mut target_x = icon_pos.x + (icon_size.width as i32) / 2 - (win_size.width as i32) / 2;
    let margin = (10.0 * scale).round() as i32;
    let mut target_y = icon_pos.y - (win_size.height as i32) - margin;

    let work = monitor.work_area();
    let pad = (8.0 * scale).round() as i32;
    let min_x = work.position.x + pad;
    let max_x = work.position.x + work.size.width as i32 - win_size.width as i32 - pad;
    let min_y = work.position.y + pad;
    let max_y = work.position.y + work.size.height as i32 - win_size.height as i32 - pad;

    if target_y < min_y {
        target_y = icon_pos.y + (icon_size.height as i32) + margin;
    }
    target_x = target_x.clamp(min_x, max_x.max(min_x));
    target_y = target_y.clamp(min_y, max_y.max(min_y));

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
        if let Ok(guard) = app.state::<AppState>().last_tray_blur.lock() {
            if let Some(at) = *guard {
                if at.elapsed() < Duration::from_millis(250) {
                    return;
                }
            }
        }
        let _ = tray_win.set_size(LogicalSize::new(380.0, 580.0));
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
    let minimized = std::env::args().any(|a| a == "--minimized");

    let Some(guard) = SingleInstanceGuard::acquire(&state_dir, !minimized) else {
        return;
    };
    let instance_guard = Arc::new(guard);
    let initial_config = load_config(&state_dir).unwrap_or_default();

    let wake_guard = Arc::clone(&instance_guard);
    let setup_guard = Arc::clone(&instance_guard);

    let app = tauri::Builder::default()
        .setup(move |app| {
            let res_dir = app.path().resource_dir().ok();
            let backend = Arc::new(BackendSupervisor::discover(
                state_dir.clone(),
                res_dir.as_deref(),
            ));
            let config = Arc::new(Mutex::new(initial_config.clone()));
            let quitting = Arc::new(AtomicBool::new(false));
            let app_state = AppState {
                backend: Arc::clone(&backend),
                config: Arc::clone(&config),
                quitting: Arc::clone(&quitting),
                cleanup_started: AtomicBool::new(false),
                last_tray_blur: Mutex::new(None),
                instance_guard: Some(setup_guard),
            };

            app.manage(app_state);

            // Start Node backend in background so window appears immediately
            let startup_backend = Arc::clone(&backend);
            let startup_config = Arc::clone(&config);
            std::thread::spawn(move || {
                let _ = ensure_backend_with_config(&startup_backend, &startup_config);
            });

            // Listen for second-instance wake signals
            let wake_app = app.handle().clone();
            let wake_quitting = Arc::clone(&quitting);
            std::thread::spawn(move || {
                while wake_guard.wait_for_wake() {
                    if wake_quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    show_main_window(&wake_app, None);
                }
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
                        show_main_window(app, None);
                    }
                    "launch_ag" => {
                        let _ = win_os::launch_antigravity();
                    }
                    "quit" => {
                        perform_cleanup(app);
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
                    std::thread::sleep(Duration::from_secs(4));
                    let state = watcher_handle.state::<AppState>();
                    if state.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    let sync_enabled = state
                        .config
                        .lock()
                        .map(|c| c.sync_antigravity_lifecycle)
                        .unwrap_or(false);
                    if !sync_enabled {
                        was_running = false;
                        continue;
                    }
                    let running = win_os::is_antigravity_running(state.backend.helper_exe.as_deref());
                    if was_running && !running {
                        perform_cleanup(&watcher_handle);
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
                    let app = window.app_handle();
                    if let Ok(mut guard) = app.state::<AppState>().last_tray_blur.lock() {
                        *guard = Some(Instant::now());
                    }
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
            save_json_file,
            open_main_window,
            hide_tray_panel,
            quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building GravityBox desktop");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            perform_cleanup(app_handle);
        }
    });
}
