import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Download, ListFilter, Tags, Search } from 'lucide-react';
import { ipcRequest } from '../ipc';
import { formatCompactTokens, formatCount, formatTimestampShort, formatUsd } from '../format';
import { BarChart } from '../components/BarChart';
import { DonutChart, DONUT_PALETTE } from '../components/DonutChart';
import { ModelIcon } from '../components/ModelIcon';
import { Modal } from '../components/Modal';
import type { GravityBoxStore } from '../hooks/useGravityBox';
import type { UsagePeriodData } from '../types';

const PERIODS = ['today', '7d', '30d', 'all'] as const;

export const UsagePage: React.FC<{ store: GravityBoxStore }> = ({ store }) => {
  const { t, reachable } = store;
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>('today');
  const [accountId, setAccountId] = useState<string>('all');
  const [data, setData] = useState<UsagePeriodData | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);
  const [showPricingModal, setShowPricingModal] = useState(false);

  const fetchUsage = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const res = await ipcRequest<UsagePeriodData & { ok?: boolean }>('usage_summary', {
          period,
          force,
          ...(accountId && accountId !== 'all' ? { accountId } : {}),
        });
        setData(res);
      } catch (err) {
        if (force) store.showToast(String(err), true);
      } finally {
        setLoading(false);
      }
    },
    [accountId, period, store],
  );

  useEffect(() => {
    void fetchUsage(false);
  }, [fetchUsage]);

  const handleExport = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gravitybox-usage-${period}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const summary = data?.summary;
  const byModel = data?.byModel ?? [];
  const totalTokens = summary?.totalTokens ?? 0;
  const totalCost = summary?.estimatedUsd ?? 0;

  const chartData =
    period === 'today'
      ? Array.from({ length: 24 }, (_, h) => {
          const pad = String(h).padStart(2, '0');
          const pt = (data?.todayHourly ?? []).find(
            (x) => x.hour.endsWith(` ${pad}:00`) || x.hour === `${pad}:00`,
          );
          const v = pt?.total_tokens ?? 0;
          return {
            label: `${pad}${store.locale === 'en' ? '' : '时'}`,
            value: v,
            tooltip: `${pad}:00 · ${formatCompactTokens(v)} Token`,
          };
        })
      : (data?.dailyTrends ?? []).map((d) => ({
          label: d.date.slice(5),
          value: d.total_tokens,
          tooltip: `${d.date} · ${formatCompactTokens(d.total_tokens)} Token`,
        }));

  const donutSlices = byModel
    .filter((m) => m.estimatedUsd > 0)
    .slice(0, 5)
    .map((m, idx) => ({
      label: m.model,
      value: m.estimatedUsd,
      color: DONUT_PALETTE[idx % DONUT_PALETTE.length],
    }));

  const avgTokensPerReq =
    summary && summary.requestCount > 0 ? summary.totalTokens / summary.requestCount : 0;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('usage.title')}</h1>
        <div className="page-actions">
          {(data?.availableAccounts?.length ?? 0) > 1 && (
            <select
              className="select"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {data!.availableAccounts!.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}
          <div className="segmented" role="tablist" aria-label={t('usage.period_a11y')}>
            {PERIODS.map((p) => (
              <button
                key={p}
                className={`segmented-btn ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {t(`usage.period.${p}`)}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => void fetchUsage(true)} disabled={!reachable || loading}>
            <RefreshCw size={13} />
            {t('common.refresh')}
          </button>
          <button className="btn" onClick={handleExport} disabled={!data}>
            <Download size={13} />
            {t('usage.export_btn')}
          </button>
        </div>
      </div>

      <div className="page-scroll">
        {/* Hero Token Usage + Chart */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
                {t('usage.section.token_usage')}
              </div>
              <div className="tabular" style={{ fontSize: 30, fontWeight: 700, marginTop: 2, letterSpacing: '-0.02em' }}>
                {summary ? formatCompactTokens(summary.totalTokens) : '--'}
              </div>
              <div className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {summary
                  ? t('usage.tokens.summary', {
                      input: formatCompactTokens(summary.promptTokens),
                      cached: formatCompactTokens(summary.cachedTokens),
                      cacheWrite: summary.cacheWriteTokens
                        ? t('usage.tokens.cache_write_part', { count: formatCompactTokens(summary.cacheWriteTokens) })
                        : '',
                      output: formatCompactTokens(summary.candidatesTokens),
                    })
                  : t('usage.tokens.placeholder')}
              </div>
            </div>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>
              {t(`usage.trend_title.${period}`)}
            </span>
          </div>

          <BarChart
            data={chartData}
            height={118}
            formatMax={formatCompactTokens}
            xLabels={
              period === 'today'
                ? ['00', '03', '06', '12', '15', '18', '23'].map((h) =>
                    store.locale === 'en' ? `${h}:00` : `${h}时`,
                  )
                : undefined
            }
          />
        </div>

        {/* Middle 2 Columns: Cost Donut + Requests & Cache */}
        <div className="grid-2">
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700 }}>{t('usage.section.cost')}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="tabular" style={{ fontSize: 16, fontWeight: 700 }}>
                  {formatUsd(totalCost)}
                </span>
                <button className="btn btn-sm" onClick={() => setShowPricingModal(true)}>
                  <Tags size={12} />
                  {t('pricing_sheet.title', undefined, '计价基准')}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <DonutChart
                slices={donutSlices}
                centerValue={formatUsd(totalCost)}
                centerLabel={store.locale === 'en' ? 'Equiv. Bill' : '等效账单'}
              />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {donutSlices.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t('common.unavailable')}
                  </div>
                ) : (
                  donutSlices.map((s) => {
                    const pct = totalCost > 0 ? Math.round((s.value / totalCost) * 100) : 0;
                    return (
                      <div key={s.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: s.color,
                            marginTop: 5,
                            flexShrink: 0,
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.label}
                          </div>
                          <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            {formatUsd(s.value)} · {pct}%
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          <div className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700 }}>{t('usage.section.requests_cache')}</span>
              <button className="btn btn-sm" onClick={() => setShowLogModal(true)}>
                <ListFilter size={12} />
                {t('usage.request_details_btn')}
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('usage.section.total_requests')}</div>
                <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {store.locale === 'en'
                    ? `Avg ${formatCompactTokens(avgTokensPerReq)} Token/req`
                    : `平均每次约 ${formatCompactTokens(avgTokensPerReq)} Token`}
                </div>
              </div>
              <div className="tabular" style={{ fontSize: 20, fontWeight: 700 }}>
                {summary ? `${formatCount(summary.requestCount)} ${store.locale === 'en' ? '' : '次'}` : '--'}
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t('usage.section.cache_hit_rate')}</div>
                  <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {store.locale === 'en'
                      ? `Cached ${formatCompactTokens(summary?.cachedTokens)} Token`
                      : `读取 ${formatCompactTokens(summary?.cachedTokens)} Token`}
                  </div>
                </div>
                <div className="tabular" style={{ fontSize: 18, fontWeight: 700 }}>
                  {summary ? `${summary.cacheHitRate.toFixed(1)}%` : '--'}
                </div>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, Math.max(0, summary?.cacheHitRate ?? 0))}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Model Breakdown */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700 }}>{t('usage.section.model_breakdown')}</span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {t('overview.bento.n_models', { count: byModel.length })}
            </span>
          </div>

          {byModel.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
              {t('overview.bento.empty_title')}
            </div>
          ) : (
            <div className="list-card" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
              {byModel.map((m) => {
                const share = totalTokens > 0 ? Math.round((m.totalTokens / totalTokens) * 100) : 0;
                return (
                  <div key={m.model} className="list-row">
                    <div className="list-row-left">
                      <span className="icon-tile gray"><ModelIcon name={m.model} size={15} /></span>
                      <div>
                        <div style={{ fontWeight: 600 }}>{m.model}</div>
                        <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                          {formatCompactTokens(m.totalTokens)} Token · {formatCount(m.requestCount)}{' '}
                          {store.locale === 'en' ? 'reqs' : '次请求'}
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="tabular" style={{ fontWeight: 700 }}>
                        {m.estimatedUsd > 0 ? formatUsd(m.estimatedUsd) : '--'}
                      </div>
                      <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                        Token {share}%
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showLogModal && (
        <UsageLogModal
          store={store}
          period={period}
          accountId={accountId}
          onClose={() => setShowLogModal(false)}
        />
      )}

      {showPricingModal && (
        <PricingSyncModal store={store} onClose={() => setShowPricingModal(false)} />
      )}
    </>
  );
};

const UsageLogModal: React.FC<{
  store: GravityBoxStore;
  period: string;
  accountId: string;
  onClose: () => void;
}> = ({ store, period, accountId, onClose }) => {
  const { t } = store;
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [snapshotId, setSnapshotId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const limit = 40;

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const res = await ipcRequest<{
          events?: Array<Record<string, unknown>>;
          total?: number;
          snapshotId?: string;
        }>('usage_events', {
          period,
          query,
          offset,
          limit,
          snapshotId,
          pinSnapshot: !snapshotId,
          ...(accountId && accountId !== 'all' ? { accountId } : {}),
        });
        if (!active) return;
        setEvents(res.events ?? []);
        setTotal(res.total ?? 0);
        if (res.snapshotId && !snapshotId) setSnapshotId(res.snapshotId);
      } catch {
        // ignore
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [accountId, offset, period, query, snapshotId]);

  useEffect(() => {
    return () => {
      if (snapshotId) {
        void ipcRequest('usage_snapshot_release', { snapshotId }).catch(() => {});
      }
    };
  }, [snapshotId]);

  return (
    <Modal
      title={t('usage_log.title', undefined, '请求明细')}
      wide
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {total} {store.locale === 'en' ? 'records' : '条记录'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
              {store.locale === 'en' ? 'Prev' : '上一页'}
            </button>
            <button className="btn btn-sm" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>
              {store.locale === 'en' ? 'Next' : '下一页'}
            </button>
            <button className="btn" onClick={onClose}>{t('common.ok')}</button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Search size={14} style={{ color: 'var(--text-secondary)' }} />
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder={t('usage_log.search_placeholder', undefined, '按模型或邮箱筛选…')}
          value={query}
          onChange={(e) => { setOffset(0); setQuery(e.target.value); }}
        />
      </div>

      {loading ? (
        <div style={{ padding: 20, color: 'var(--text-secondary)' }}>{t('status.running_tasks')}</div>
      ) : events.length === 0 ? (
        <div style={{ padding: 20, color: 'var(--text-secondary)' }}>{t('usage_log.empty', undefined, '暂无记录')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {events.map((ev, i) => (
            <div key={i} className="card-subtle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12.5 }}>
                  <ModelIcon name={String(ev.model || '')} size={13} />
                  <span>{String(ev.model || '--')}</span>
                  {ev.account_email ? (
                    <span className="badge neutral">{String(ev.account_email)}</span>
                  ) : null}
                </div>
                <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {formatTimestampShort(ev.timestamp_seconds as number)} · In {formatCompactTokens(ev.input_tokens as number)} · Cache {formatCompactTokens(ev.cached_tokens as number)} · Out {formatCompactTokens(ev.output_tokens as number)}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="tabular" style={{ fontWeight: 700 }}>
                  {formatCompactTokens(ev.total_tokens as number)}
                </div>
                {typeof ev.estimated_usd === 'number' && ev.estimated_usd > 0 && (
                  <div className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {formatUsd(ev.estimated_usd)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};

const PricingSyncModal: React.FC<{
  store: GravityBoxStore;
  onClose: () => void;
}> = ({ store, onClose }) => {
  const { t } = store;
  const [models, setModels] = useState<Array<{ id: string; inputPerMillion?: number; outputPerMillion?: number; cachedPerMillion?: number; source?: string }>>([]);
  const [syncing, setSyncing] = useState(false);
  const [preview, setPreview] = useState<{ previewId?: string; affectedCount?: number; oldUsd?: number; newUsd?: number } | null>(null);

  const loadCatalog = useCallback(async () => {
    try {
      const res = await ipcRequest<{
        models?: Array<{ id: string; inputPerMillion?: number; outputPerMillion?: number; cachedPerMillion?: number; source?: string }>;
        pricing?: Record<string, { inputPerMillion?: number; outputPerMillion?: number; cachedPerMillion?: number }>;
      }>('api_pricing_get');
      if (Array.isArray(res.models)) {
        setModels(res.models);
      } else if (res.pricing) {
        setModels(
          Object.entries(res.pricing).map(([id, p]) => ({ id, ...p })),
        );
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const res = await ipcRequest<{ appliedCount?: number }>('pricing_sync_check');
      await loadCatalog();
      store.showToast(t('settings.pricing_sync.synced', { count: res.appliedCount ?? models.length }));
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setSyncing(false);
    }
  };

  const handleRevaluePreview = async () => {
    try {
      const res = await ipcRequest<{ preview?: { previewId?: string; affectedCount?: number; oldUsd?: number; newUsd?: number } }>('api_pricing_revalue_preview', { mode: 'unpriced_only' });
      if (res.preview) setPreview(res.preview);
    } catch (err) {
      store.showToast(String(err), true);
    }
  };

  const handleRevalueExecute = async () => {
    if (!preview?.previewId) return;
    try {
      await ipcRequest('api_pricing_revalue', {
        confirm: true,
        mode: 'unpriced_only',
        previewId: preview.previewId,
      });
      setPreview(null);
      store.showToast(t('common.ok'));
    } catch (err) {
      store.showToast(String(err), true);
    }
  };

  return (
    <Modal
      title={t('pricing_sheet.title', undefined, '计价基准与费率')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => void handleRevaluePreview()}>
            {t('pricing_sheet.revalue_btn', undefined, '重估未计价历史')}
          </button>
          <button className="btn" disabled={syncing} onClick={() => void handleSyncNow()}>
            <RefreshCw size={12} />
            {t('settings.pricing_sync.check_now')}
          </button>
          <button className="btn btn-primary" onClick={onClose}>{t('common.ok')}</button>
        </>
      }
    >
      {preview && (
        <div className="card-subtle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12 }}>
            {store.locale === 'en'
              ? `Will update ${preview.affectedCount ?? 0} records`
              : `可更新 ${preview.affectedCount ?? 0} 条未计价记录`}
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => void handleRevalueExecute()}>
            {store.locale === 'en' ? 'Apply' : '确认应用'}
          </button>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {models.map((m) => (
          <div key={m.id} className="card-subtle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              <ModelIcon name={m.id} size={13} />
              {m.id}
            </span>
            <span className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              In ${m.inputPerMillion ?? '--'} · Cache ${m.cachedPerMillion ?? '--'} · Out ${m.outputPerMillion ?? '--'} / 1M
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
};
