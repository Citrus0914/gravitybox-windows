import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  MoreHorizontal,
  ExternalLink,
  ArrowUpRight,
  Check,
  Sparkles,
  Send,
  DollarSign,
  Zap,
} from 'lucide-react';
import {
  hideTrayPanel,
  ipcRequest,
  launchAntigravity,
  openMainWindow,
  quitApp,
} from '../ipc';
import {
  formatCompactTokens,
  formatCount,
  formatUsd,
  statusColorForMode,
} from '../format';
import { BrandLogo, ModelIcon } from '../components/ModelIcon';
import { BarChart } from '../components/BarChart';
import type { GravityBoxStore } from '../hooks/useGravityBox';
import type { UsagePeriodData } from '../types';

const PERIODS = ['today', '7d', '30d', 'all'] as const;

export const TrayPanel: React.FC<{ store: GravityBoxStore }> = ({ store }) => {
  const { t, config, status, reachable } = store;
  const [periodIdx, setPeriodIdx] = useState<number>(config?.menuUsagePeriod ?? 0);
  const [metric, setMetric] = useState<'tokens' | 'requests'>(config?.menuTrendMetric ?? 'tokens');
  const [usage, setUsage] = useState<UsagePeriodData | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!config || hydratedRef.current) return;
    hydratedRef.current = true;
    if (typeof config.menuUsagePeriod === 'number') setPeriodIdx(config.menuUsagePeriod);
    if (config.menuTrendMetric === 'requests' || config.menuTrendMetric === 'tokens') {
      setMetric(config.menuTrendMetric);
    }
  }, [config]);

  const period = PERIODS[periodIdx] ?? 'today';

  const fetchUsage = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const res = await ipcRequest<UsagePeriodData>('usage_summary', { period, force });
      setUsage(res);
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => {
    void fetchUsage(false);
  }, [fetchUsage]);

  useEffect(() => {
    const unlistenPromise = listen('tray-opened', () => {
      void store.refreshStatus(false);
      void fetchUsage(false);
    });
    const onGlobalClick = () => setMenuOpen(false);
    window.addEventListener('click', onGlobalClick);
    return () => {
      window.removeEventListener('click', onGlobalClick);
      void unlistenPromise.then((fn) => fn());
    };
  }, [fetchUsage, store]);

  const switchPeriod = (idx: number) => {
    setPeriodIdx(idx);
    setShowAllModels(false);
    void store.updateConfig({ menuUsagePeriod: idx }).catch(() => {});
  };

  const switchMetric = (m: 'tokens' | 'requests') => {
    setMetric(m);
    void store.updateConfig({ menuTrendMetric: m }).catch(() => {});
  };

  const openPage = async (page: number) => {
    await hideTrayPanel().catch(() => {});
    await openMainWindow(page);
  };

  const dotColor = statusColorForMode(status?.mode, reachable);
  const models = usage?.byModel ?? [];
  const visibleModels = showAllModels ? models : models.slice(0, 3);
  const maxModelTokens = Math.max(1, ...models.map((m) => m.totalTokens || 0));

  const chartData =
    period === 'today'
      ? Array.from({ length: 24 }, (_, h) => {
          const pad = String(h).padStart(2, '0');
          const pt = (usage?.todayHourly ?? []).find(
            (x) => x.hour.endsWith(` ${pad}:00`) || x.hour === `${pad}:00`,
          );
          const v = metric === 'requests' ? (pt?.request_count ?? 0) : (pt?.total_tokens ?? 0);
          return {
            label: `${pad}${store.locale === 'en' ? '' : '时'}`,
            value: v,
          };
        })
      : (usage?.dailyTrends ?? []).map((d) => ({
          label: d.date.slice(5),
          value: metric === 'requests' ? d.request_count : d.total_tokens,
        }));

  const hudEnabled = status?.hudEnabled ?? config?.hudEnabled ?? true;

  return (
    <div className="tray-shell">
      {/* Header */}
      <div className="tray-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <BrandLogo size={18} />
          <span style={{ fontWeight: 700, fontSize: 14 }}>GravityBox</span>
          <span className={`status-dot ${dotColor}`} title={store.statusLabel} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            className="btn btn-sm"
            disabled={!reachable || refreshing}
            onClick={() => void fetchUsage(true)}
          >
            {t('common.refresh')}
          </button>

          <div className="dropdown-wrap" onClick={(e) => e.stopPropagation()}>
            <button
              className="btn btn-sm btn-icon"
              aria-label={t('menu.more_actions')}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <MoreHorizontal size={14} />
            </button>
            {menuOpen && (
              <div className="dropdown-menu">
                <button
                  className="dropdown-item"
                  onClick={() => { setMenuOpen(false); void store.setHudEnabled(!hudEnabled); }}
                >
                  <span>{t('settings.hud.title')}</span>
                  {hudEnabled && <Check size={13} />}
                </button>
                <div className="dropdown-sep" />
                <button
                  className="dropdown-item"
                  onClick={() => { setMenuOpen(false); void store.setLanguage('system'); }}
                >
                  <span>{t('language.system')}</span>
                  {store.configuredLanguage === 'system' && <Check size={13} />}
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => { setMenuOpen(false); void store.setLanguage('zh-Hans'); }}
                >
                  <span>简体中文</span>
                  {store.configuredLanguage === 'zh-Hans' && <Check size={13} />}
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => { setMenuOpen(false); void store.setLanguage('en'); }}
                >
                  <span>English</span>
                  {store.configuredLanguage === 'en' && <Check size={13} />}
                </button>
                <div className="dropdown-sep" />
                <button className="dropdown-item" onClick={() => { setMenuOpen(false); void openPage(1); }}>
                  <span>{t('nav.settings')}</span>
                </button>
                <button className="dropdown-item danger" onClick={() => void quitApp()}>
                  <span>{t('menu.quit')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="tray-body">
        <div className="segmented full">
          {PERIODS.map((p, idx) => (
            <button
              key={p}
              className={`segmented-btn ${periodIdx === idx ? 'active' : ''}`}
              onClick={() => switchPeriod(idx)}
            >
              {t(`usage.period.${p}`)}
            </button>
          ))}
        </div>

        <div className="grid-2" style={{ gap: 8 }}>
          <div className="card" style={{ padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }}>
              <Sparkles size={12} color="var(--accent)" />
              {t('usage.section.token_usage')}
            </div>
            <div className="tabular" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {usage ? formatCompactTokens(usage.summary.totalTokens) : '--'}
            </div>
          </div>

          <div className="card" style={{ padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }}>
              <Send size={12} color="var(--text-secondary)" />
              {t('usage.section.total_requests')}
            </div>
            <div className="tabular" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {usage ? formatCount(usage.summary.requestCount) : '--'}
            </div>
          </div>

          <div className="card" style={{ padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }}>
              <DollarSign size={12} color="var(--green)" />
              {t('usage.section.cost')}
            </div>
            <div className="tabular" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {usage ? formatUsd(usage.summary.estimatedUsd) : '--'}
            </div>
          </div>

          <div className="card" style={{ padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }}>
              <Zap size={12} color="var(--amber)" />
              {t('usage.section.cache_hit_rate')}
            </div>
            <div className="tabular" style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {usage ? `${usage.summary.cacheHitRate.toFixed(1)}%` : '--'}
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>
              {t(`usage.trend_title.${period}`)}
            </span>
            <div className="segmented" style={{ padding: 2 }}>
              <button
                className={`segmented-btn ${metric === 'tokens' ? 'active' : ''}`}
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() => switchMetric('tokens')}
              >
                Token
              </button>
              <button
                className={`segmented-btn ${metric === 'requests' ? 'active' : ''}`}
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={() => switchMetric('requests')}
              >
                {store.locale === 'en' ? 'Reqs' : '请求'}
              </button>
            </div>
          </div>
          <BarChart
            data={chartData}
            height={78}
            formatMax={(v) => (metric === 'requests' ? formatCount(v) : formatCompactTokens(v))}
            xLabels={
              period === 'today'
                ? ['00', '06', '12', '18', '23'].map((h) => (store.locale === 'en' ? h : `${h}时`))
                : undefined
            }
          />
        </div>

        <div className="card" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>{t('usage.section.model_breakdown')}</span>
            <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              {t('overview.bento.n_models', { count: models.length })}
            </span>
          </div>
          {visibleModels.map((m) => (
            <div key={m.model} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                  <ModelIcon name={m.model} size={13} />
                  {m.model}
                </span>
                <span className="tabular" style={{ fontWeight: 700 }}>
                  {formatCompactTokens(m.totalTokens)}
                </span>
              </div>
              <div className="progress-track" style={{ height: 4 }}>
                <div
                  className="progress-fill"
                  style={{ width: `${Math.max(4, Math.round((m.totalTokens / maxModelTokens) * 100))}%` }}
                />
              </div>
            </div>
          ))}
          {models.length > 3 && (
            <button
              className="btn btn-sm"
              onClick={() => setShowAllModels(!showAllModels)}
              style={{ alignSelf: 'flex-start' }}
            >
              {showAllModels
                ? (store.locale === 'en' ? 'Collapse' : '收起')
                : (store.locale === 'en' ? `Show ${models.length - 3} more` : `展开其余 ${models.length - 3} 个模型`)}
            </button>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="tray-footer">
        <button className="btn btn-sm" onClick={() => void launchAntigravity().catch((e) => store.showToast(String(e), true))}>
          <ExternalLink size={12} />
          {t('sidebar.open_antigravity')}
        </button>
        <button className="btn btn-sm" onClick={() => void openPage(0)}>
          {t('menu_panel.footer.open_usage', undefined, '打开用量页')}
          <ArrowUpRight size={12} />
        </button>
      </div>
    </div>
  );
};
