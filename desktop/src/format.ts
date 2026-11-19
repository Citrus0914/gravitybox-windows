import type { AccountItem, QuotaGroup } from './types';

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

export interface NormalizedQuotaBar {
  key: string;
  label: string;
  family: 'gemini' | 'claude' | 'argon' | 'carbon' | 'other';
  percentage: number | null;
  resetCountdown: string;
  stale: boolean;
}

export function extractQuotaBars(
  source: Pick<
    AccountItem,
    | 'quotaGroups'
    | 'geminiFiveHourRemaining'
    | 'geminiWeeklyRemaining'
    | 'geminiFiveHourResetCountdown'
    | 'geminiWeeklyResetCountdown'
    | 'claudeFiveHourRemaining'
    | 'claudeWeeklyRemaining'
    | 'claudeFiveHourResetCountdown'
    | 'claudeWeeklyResetCountdown'
    | 'argonWeeklyRemaining'
    | 'argonWeeklyResetCountdown'
    | 'carbonWeeklyRemaining'
    | 'carbonWeeklyResetCountdown'
    | 'staleGroups'
  > | null | undefined,
  t: (key: string, params?: Record<string, string | number>, fallback?: string) => string,
): NormalizedQuotaBar[] {
  if (!source) return [];
  const staleSet = new Set((source.staleGroups ?? []).map((s) => String(s).toLowerCase()));
  const bars: NormalizedQuotaBar[] = [];

  if (Array.isArray(source.quotaGroups) && source.quotaGroups.length > 0) {
    for (const grp of source.quotaGroups as QuotaGroup[]) {
      const grpKey = String(grp.key || grp.id || grp.title || grp.label || '');
      const famLower = `${grp.family ?? ''} ${grpKey}`.toLowerCase();
      const family: NormalizedQuotaBar['family'] = famLower.includes('claude') || famLower.includes('gpt')
        ? 'claude'
        : famLower.includes('argon')
          ? 'argon'
          : famLower.includes('carbon')
            ? 'carbon'
            : famLower.includes('gemini')
              ? 'gemini'
              : 'other';

      if (Array.isArray(grp.windows) && grp.windows.length > 0) {
        for (const win of grp.windows) {
          const periodLabel = win.period === '5h'
            ? t('common.period.5h', undefined, '5h')
            : win.period === 'weekly'
              ? t('common.period.weekly', undefined, 'Weekly')
              : win.period === 'daily'
                ? t('common.period.daily', undefined, 'Daily')
                : (win.label ?? '');
          const baseTitle = grp.title || grp.label || grpKey;
          const label = periodLabel && !baseTitle.includes(periodLabel) ? `${baseTitle} · ${periodLabel}` : baseTitle;
          bars.push({
            key: `${grpKey}:${win.key ?? win.period ?? label}`,
            label,
            family,
            percentage: typeof win.percentage === 'number' ? win.percentage : null,
            resetCountdown: win.resetCountdown ?? '',
            stale: Boolean(win.stale || grp.stale || staleSet.has(grpKey.toLowerCase())),
          });
        }
      } else {
        bars.push({
          key: grpKey || String(bars.length),
          label: grp.title || grp.label || grpKey,
          family,
          percentage: typeof grp.percentage === 'number' ? grp.percentage : null,
          resetCountdown: grp.resetCountdown ?? '',
          stale: Boolean(grp.stale || staleSet.has(grpKey.toLowerCase())),
        });
      }
    }
    if (bars.length > 0) return bars;
  }

  if (source.geminiFiveHourRemaining !== undefined && source.geminiFiveHourRemaining !== null) {
    bars.push({
      key: 'gemini-5h',
      label: t('quota.bar.gemini_5h', undefined, 'Gemini · 5h'),
      family: 'gemini',
      percentage: source.geminiFiveHourRemaining,
      resetCountdown: source.geminiFiveHourResetCountdown ?? '',
      stale: staleSet.has('gemini_5h'),
    });
  }
  if (source.geminiWeeklyRemaining !== undefined && source.geminiWeeklyRemaining !== null) {
    bars.push({
      key: 'gemini-weekly',
      label: t('quota.bar.gemini_weekly', undefined, 'Gemini · Weekly'),
      family: 'gemini',
      percentage: source.geminiWeeklyRemaining,
      resetCountdown: source.geminiWeeklyResetCountdown ?? '',
      stale: staleSet.has('gemini_weekly'),
    });
  }
  if (source.claudeFiveHourRemaining !== undefined && source.claudeFiveHourRemaining !== null) {
    bars.push({
      key: 'claude-5h',
      label: t('quota.bar.claude_5h', undefined, 'Claude/GPT · 5h'),
      family: 'claude',
      percentage: source.claudeFiveHourRemaining,
      resetCountdown: source.claudeFiveHourResetCountdown ?? '',
      stale: staleSet.has('claude_5h'),
    });
  }
  if (source.claudeWeeklyRemaining !== undefined && source.claudeWeeklyRemaining !== null) {
    bars.push({
      key: 'claude-weekly',
      label: t('quota.bar.claude_weekly', undefined, 'Claude/GPT · Weekly'),
      family: 'claude',
      percentage: source.claudeWeeklyRemaining,
      resetCountdown: source.claudeWeeklyResetCountdown ?? '',
      stale: staleSet.has('claude_weekly'),
    });
  }
  if (source.argonWeeklyRemaining !== undefined && source.argonWeeklyRemaining !== null) {
    bars.push({
      key: 'argon-weekly',
      label: `Gemini 4 Argon · ${t('common.period.weekly', undefined, 'Weekly')}`,
      family: 'argon',
      percentage: source.argonWeeklyRemaining,
      resetCountdown: source.argonWeeklyResetCountdown ?? '',
      stale: staleSet.has('argon_weekly'),
    });
  }
  if (source.carbonWeeklyRemaining !== undefined && source.carbonWeeklyRemaining !== null) {
    bars.push({
      key: 'carbon-weekly',
      label: `Gemini 4 Carbon · ${t('common.period.weekly', undefined, 'Weekly')}`,
      family: 'carbon',
      percentage: source.carbonWeeklyRemaining,
      resetCountdown: source.carbonWeeklyResetCountdown ?? '',
      stale: staleSet.has('carbon_weekly'),
    });
  }
  return bars;
}

export function statusColorForMode(mode: string | undefined, reachable: boolean): 'green' | 'amber' | 'red' | 'gray' {
  if (!reachable) return 'red';
  switch (mode) {
    case 'connected':
    case 'active':
    case 'english':
      return 'green';
    case 'paused':
    case 'waiting':
    case 'waiting_window':
    case 'waiting_app':
    case 'starting':
      return 'amber';
    case 'error':
    case 'legacy_blocked':
    case 'stopped':
      return 'red';
    default:
      return 'gray';
  }
}
