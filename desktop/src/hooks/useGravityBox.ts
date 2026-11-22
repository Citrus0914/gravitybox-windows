import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  getAppRuntimeInfo,
  ipcRequest,
  loadAppConfig,
  saveAppConfig,
} from '../ipc';
import { formatStatusLabel } from '../format';
import { resolveLocaleFromPreference, translate, type ResolvedLocale } from '../i18n';
import type { AppConfig, AppRuntimeInfo, StatusSnapshot, TaskItem } from '../types';

export interface ToastState {
  id: number;
  message: string;
  error?: boolean;
}

export function useGravityBox() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [runtime, setRuntime] = useState<AppRuntimeInfo | null>(null);
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [reachable, setReachable] = useState<boolean>(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lastTaskRevisionRef = useRef<number>(-1);

  const showToast = useCallback((message: string, error = false) => {
    const id = Date.now();
    setToast({ id, message, error });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, error ? 5500 : 3500);
  }, []);

  const refreshRuntime = useCallback(async () => {
    try {
      const info = await getAppRuntimeInfo();
      setRuntime(info);
    } catch {
      // ignore
    }
  }, []);

  const refreshStatus = useCallback(async (forceTasks = false) => {
    try {
      const res = await ipcRequest<{
        ok: boolean;
        status?: StatusSnapshot;
        taskRevision?: number;
        tasks?: TaskItem[];
      }>('status', {
        includeTasks: true,
        tasksSince: forceTasks ? -1 : lastTaskRevisionRef.current,
      });
      setReachable(true);
      if (res.status) setStatus(res.status);
      if (typeof res.taskRevision === 'number') {
        lastTaskRevisionRef.current = res.taskRevision;
      }
      if (Array.isArray(res.tasks)) {
        setTasks(res.tasks);
      }
      return true;
    } catch {
      setReachable(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const isTrayView = new URLSearchParams(window.location.search).get('view') === 'tray';
    void loadAppConfig().then(setConfig).catch(() => {});
    void refreshRuntime();
    void refreshStatus(true);

    const statusTimer = isTrayView
      ? null
      : window.setInterval(() => {
          void refreshStatus(false);
          void refreshRuntime();
        }, 4000);

    const unlistenPromise = listen<AppConfig>('config-changed', (ev) => {
      setConfig(ev.payload);
    });

    return () => {
      if (statusTimer !== null) window.clearInterval(statusTimer);
      void unlistenPromise.then((fn) => fn());
    };
  }, [refreshRuntime, refreshStatus]);

  const configuredLanguage = useMemo(() => {
    return (
      status?.configuredLanguage ||
      config?.appLanguage ||
      'system'
    );
  }, [config?.appLanguage, status?.configuredLanguage]);

  const locale: ResolvedLocale = useMemo(() => {
    if (status?.locale === 'en' || status?.locale === 'zh-Hans') {
      return status.locale;
    }
    return resolveLocaleFromPreference(configuredLanguage, runtime?.systemLocales);
  }, [configuredLanguage, runtime?.systemLocales, status?.locale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>, fallback?: string) =>
      translate(locale, key, params, fallback),
    [locale],
  );

  const updateConfig = useCallback(async (patch: Partial<AppConfig>) => {
    const saved = await saveAppConfig(patch);
    setConfig(saved);
    return saved;
  }, []);

  const setLanguage = useCallback(
    async (lang: string) => {
      const target = lang.trim() || 'system';
      await updateConfig({ appLanguage: target });
      try {
        const res = await ipcRequest<{ status?: StatusSnapshot }>('language_set', {
          language: target,
          systemLocales: runtime?.systemLocales ?? [navigator.language || 'zh-CN'],
        });
        if (res.status) setStatus(res.status);
        void refreshStatus(true);
      } catch (err) {
        showToast(String(err), true);
      }
    },
    [refreshStatus, runtime?.systemLocales, showToast, updateConfig],
  );

  const setHudEnabled = useCallback(
    async (enabled: boolean) => {
      await updateConfig({ hudEnabled: enabled });
      try {
        const res = await ipcRequest<{ status?: StatusSnapshot }>('hud_set', { enabled });
        if (res.status) setStatus(res.status);
      } catch (err) {
        showToast(String(err), true);
      }
    },
    [showToast, updateConfig],
  );

  const statusLabel = useMemo(
    () => formatStatusLabel(status, reachable, locale, t),
    [locale, reachable, status, t],
  );

  return {
    config,
    runtime,
    status,
    tasks,
    reachable,
    locale,
    configuredLanguage,
    statusLabel,
    toast,
    showToast,
    clearToast: () => setToast(null),
    refreshStatus,
    refreshRuntime,
    updateConfig,
    setLanguage,
    setHudEnabled,
    t,
  };
}

export type GravityBoxStore = ReturnType<typeof useGravityBox>;
