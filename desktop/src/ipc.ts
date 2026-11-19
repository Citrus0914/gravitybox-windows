import { invoke } from '@tauri-apps/api/core';
import type { AppConfig, AppRuntimeInfo } from './types';

export async function ipcRequest<T = Record<string, unknown>>(
  command: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>('ipc_request', {
    payload: { command, ...params },
  });
}

export function restartBackend(): Promise<boolean> {
  return invoke<boolean>('restart_backend');
}

export function loadAppConfig(): Promise<AppConfig> {
  return invoke<AppConfig>('load_app_config');
}

export function saveAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  return invoke<AppConfig>('save_app_config', { patch });
}

export function getAppRuntimeInfo(): Promise<AppRuntimeInfo> {
  return invoke<AppRuntimeInfo>('get_app_runtime_info');
}

export function setAutoStart(enabled: boolean): Promise<boolean> {
  return invoke<boolean>('set_auto_start', { enabled });
}

export function launchAntigravity(): Promise<void> {
  return invoke<void>('launch_antigravity');
}

export function quitAntigravityAndWait(): Promise<boolean> {
  return invoke<boolean>('quit_antigravity_and_wait');
}

export function revealStateDir(): Promise<void> {
  return invoke<void>('reveal_state_dir');
}

export function revealPath(path: string): Promise<void> {
  return invoke<void>('reveal_path', { path });
}

export function openExternalUrl(url: string): Promise<void> {
  return invoke<void>('open_external_url', { url });
}

export function openMainWindow(page?: number): Promise<void> {
  return invoke<void>('open_main_window', { page: page ?? null });
}

export function hideTrayPanel(): Promise<void> {
  return invoke<void>('hide_tray_panel');
}

export function quitApp(): Promise<void> {
  return invoke<void>('quit_app');
}
