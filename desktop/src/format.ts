import type { StatusSnapshot } from './types';

export function formatCompactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, '')}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return Math.round(value).toLocaleString();
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '0 B';
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return Math.round(value).toLocaleString();
}

export function formatTimestampShort(ts: number | string | null | undefined): string {
  if (!ts) return '--';
  const ms = typeof ts === 'number' ? (ts < 1e11 ? ts * 1000 : ts) : Date.parse(ts);
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

export function formatTimeOnly(ts: number | string | null | undefined): string {
  if (!ts) return '--';
  const ms = typeof ts === 'number' ? (ts < 1e11 ? ts * 1000 : ts) : Date.parse(ts);
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function statusColorForMode(mode: string | undefined, reachable: boolean): 'green' | 'amber' | 'red' | 'gray' {
  if (!reachable) return 'red';
  switch (mode) {
    case 'connected':
    case 'active':
      return 'green';
    case 'paused':
    case 'waiting':
    case 'waiting-window':
    case 'waiting_window':
    case 'waiting-app':
    case 'waiting_app':
    case 'starting':
      return 'amber';
    case 'error':
    case 'stopped':
      return 'red';
    default:
      return 'gray';
  }
}

export function formatStatusLabel(
  status: StatusSnapshot | null | undefined,
  reachable: boolean,
  locale: string,
  t: (key: string, params?: Record<string, string | number>, fallback?: string) => string,
): string {
  if (!reachable) return t('status.disconnected');
  if (Array.isArray(status?.errors) && status.errors.length > 0) return t('status.check_partial');
  const mode = status?.mode ?? '';
  if (mode === 'connected' || mode === 'active') {
    return t('status.hud_connected', undefined, locale === 'en' ? 'HUD Connected' : 'HUD 已连接');
  }
  if (mode === 'paused') {
    return t('status.hud_paused', undefined, locale === 'en' ? 'HUD Paused' : 'HUD 已暂停');
  }
  if (mode === 'waiting-window' || mode === 'waiting_window') return t('status.waiting_window');
  if (mode === 'waiting-app' || mode === 'waiting_app') return t('status.waiting_app');
  if (mode === 'waiting' || mode === 'starting') return t('status.waiting');
  if (mode === 'error') return t('status.error');
  if (mode === 'stopped') return t('status.stopped');
  return t('status.waiting_app');
}
