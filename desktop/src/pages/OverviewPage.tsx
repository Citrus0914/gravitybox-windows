import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Sparkles, DollarSign, Send, BarChart3, Layers, ArrowUpRight } from 'lucide-react';
import { ipcRequest } from '../ipc';
import {
  extractQuotaBars,
  formatCompactTokens,
  formatCount,
  formatTimestampShort,
  formatUsd,
  statusColorForMode,
} from '../format';
import { QuotaBar } from '../components/QuotaBar';
import { BarChart } from '../components/BarChart';
import { ModelIcon } from '../components/ModelIcon';
import type { GravityBoxStore } from '../hooks/useGravityBox';
import type { DashboardSummary } from '../types';

export const OverviewPage: React.FC<{
  store: GravityBoxStore;
  onNavigate: (page: number) => void;
}> = ({ store, onNavigate }) => {
  const { t, reachable, status, statusLabel } = store;
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingQuota, setRefreshingQuota] = useState(false);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await ipcRequest<DashboardSummary & { ok?: boolean }>('dashboard_summary');
      setData(res);
    } catch {
      // keep cached
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
    const timer = window.setInterval(() => void fetchSummary(), 8000);
    return () => window.clearInterval(timer);
  }, [fetchSummary]);

  const handleRefreshQuota = async () => {
    if (refreshingQuota) return;
    setRefreshingQuota(true);
    try {
      const id = data?.accounts?.currentAccountId;
      if (id) {
        await ipcRequest('quota_refresh', { id });
      } else {
        await ipcRequest('quota_refresh_all');
      }
      await fetchSummary();
      void store.refreshStatus(true);
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setRefreshingQuota(false);
    }
  };

  const acc = data?.accounts;
  const usage = data?.usage;
  const quotaBars = extractQuotaBars(acc, t);
  const hourly = usage?.todayHourly ?? [];
  const hourlyData = Array.from({ length: 24 }, (_, h) => {
    const pad = String(h).padStart(2, '0');
    const found = hourly.find((pt) => pt.hour.endsWith(` ${pad}:00`) || pt.hour === `${pad}:00`);
    const val = found?.total_tokens ?? 0;
    return {
      label: `${pad}${store.locale === 'en' ? '' : '时'}`,
      value: val,
      tooltip: `${pad}:00 · ${formatCompactTokens(val)} Token`,
    };
  });
  const peakPoint = hourlyData.reduce(
    (best, cur) => (cur.value > best.value ? cur : best),
    { label: '00', value: 0, tooltip: '' },
  );

  const models = usage?.todayByModel ?? [];
  const topModels = models.slice(0, 2);
  const totalTodayModelTokens = models.reduce((s, m) => s + (m.totalTokens || 0), 0);

  const dotColor = statusColorForMode(status?.mode, reachable);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('overview.title')}</h1>
        <div className="page-actions">
          <span className="badge neutral" style={{ padding: '4px 10px', gap: 6 }}>
            <span className={`status-dot ${dotColor}`} />
            {statusLabel}
          </span>
          <button
            className="btn"
            onClick={() => void fetchSummary()}
            disabled={!reachable}
          >
            <RefreshCw size={13} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="page-scroll">
        {/* Active Account & Quota Card */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>
                  {acc?.activeName || acc?.activeEmail || (loading ? t('overview.loading_account') : t('common.unknown'))}
                </span>
                {acc?.activeTier && (
                  <span className="badge">{acc.activeTier}</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {acc?.activeEmail || data?.accountsError || '--'}
              </div>
            </div>
            <button
              className="btn"
              onClick={() => void handleRefreshQuota()}
              disabled={!reachable || refreshingQuota}
            >
              <RefreshCw size={13} className={refreshingQuota ? 'spin' : ''} />
              {t('common.refresh_quota')}
            </button>
          </div>

          {quotaBars.length > 0 ? (
            <div className="grid-2" style={{ marginTop: 14, rowGap: 12, columnGap: 18 }}>
              {quotaBars.map((bar) => (
                <QuotaBar key={bar.key} bar={bar} />
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
              {acc?.quotaRefreshError || t('quota.unknown')}
            </div>
          )}

          <div
            style={{
              marginTop: 12,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 11.5,
              color: 'var(--text-secondary)',
            }}
          >
            <span>
              {acc?.quotaLastUpdated
                ? t('common.updated_at', { time: formatTimestampShort(acc.quotaLastUpdated) })
                : ''}
            </span>
            {acc?.staleGroups && acc.staleGroups.length > 0 && (
              <span style={{ color: 'var(--amber)' }}>
                {t('overview.status.stale_groups', { count: acc.staleGroups.length })}
              </span>
            )}
          </div>
        </div>

        {/* 3 KPI Cards */}
        <div className="grid-3">
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="icon-tile"><Sparkles size={15} /></span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                {t('overview.metric.today_tokens')}
              </span>
            </div>
            <div className="tabular" style={{ fontSize: 26, fontWeight: 700, marginTop: 8, letterSpacing: '-0.02em' }}>
              {usage ? formatCompactTokens(usage.todayTokens) : '--'}
            </div>
            <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
              {usage
                ? t('overview.metric.total_tokens', { tokens: formatCompactTokens(usage.totalTokens) })
                : t('overview.metric.total_tokens_placeholder')}
            </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="icon-tile green"><DollarSign size={15} /></span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                {t('overview.metric.today_cost')}
              </span>
            </div>
            <div className="tabular" style={{ fontSize: 26, fontWeight: 700, marginTop: 8, letterSpacing: '-0.02em' }}>
              {usage ? formatUsd(usage.estimatedUsd) : '--'}
            </div>
            <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
              {usage
                ? t('overview.metric.total_cost', { cost: formatUsd(usage.allTimeEstimatedUsd) })
                : t('overview.metric.total_cost_placeholder')}
            </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="icon-tile purple"><Send size={15} /></span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                {t('overview.metric.today_requests')}
              </span>
            </div>
            <div className="tabular" style={{ fontSize: 26, fontWeight: 700, marginTop: 8, letterSpacing: '-0.02em' }}>
              {usage ? formatCount(usage.requestCount) : '--'}
            </div>
            <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
              {usage
                ? t('overview.metric.total_requests', { count: formatCount(usage.totalRequestCount) })
                : t('overview.metric.total_requests_placeholder')}
            </div>
          </div>
        </div>

        {/* Bottom 2-Column Bento */}
        <div className="grid-2">
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="icon-tile"><BarChart3 size={15} /></span>
                <span style={{ fontWeight: 700 }}>{t('overview.trend.title')}</span>
              </div>
              <span className="badge">
                {peakPoint.value > 0
                  ? t('overview.trend.peak_badge', { label: peakPoint.label, peak: formatCompactTokens(peakPoint.value) })
                  : t('overview.trend.24h_badge')}
              </span>
            </div>
            <BarChart
              data={hourlyData}
              height={118}
              formatMax={formatCompactTokens}
              xLabels={['00', '04', '08', '12', '16', '20', '23'].map((h) =>
                store.locale === 'en' ? `${h}:00` : `${h}时`,
              )}
            />
          </div>

          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="icon-tile"><Layers size={15} /></span>
                <span style={{ fontWeight: 700 }}>{t('overview.bento.active_models')}</span>
              </div>
              <button
                className="badge"
                style={{ border: 'none', cursor: 'pointer' }}
                onClick={() => onNavigate(2)}
              >
                {models.length === 0
                  ? t('overview.bento.no_calls_badge')
                  : t('overview.bento.topn_of_m', { shown: topModels.length, count: models.length })}
                <ArrowUpRight size={11} />
              </button>
            </div>

            {topModels.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {topModels.map((m) => {
                  const pct = totalTodayModelTokens > 0
                    ? Math.round((m.totalTokens / totalTodayModelTokens) * 100)
                    : 0;
                  const share = models.length > 1 ? t('overview.bento.share_pct', { pct }) : '';
                  const cost = m.estimatedUsd > 0 ? ` · ${formatUsd(m.estimatedUsd)}` : '';
                  return (
                    <div key={m.model} className="card-subtle">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12.5 }}>
                          <ModelIcon name={m.model} size={14} />
                          {m.model}
                        </span>
                        <span className="tabular" style={{ fontWeight: 700, fontSize: 12.5 }}>
                          {t('overview.bento.tokens_trailing', { tokens: formatCompactTokens(m.totalTokens) })}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                        {models.length > 1
                          ? t('overview.bento.model_sub_multi', { reqs: formatCount(m.requestCount), share, cost })
                          : t('overview.bento.model_sub_single', { reqs: formatCount(m.requestCount), cost })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="card-subtle" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, fontSize: 12.5 }}>{t('overview.bento.empty_title')}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                  {t('overview.bento.empty_sub')}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
