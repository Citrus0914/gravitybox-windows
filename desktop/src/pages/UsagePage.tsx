import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Download, ListFilter, Tags, Search, Folder, MessageSquare, ChevronRight, ChevronDown } from 'lucide-react';
import { ipcRequest, saveJsonFile } from '../ipc';
import { formatCompactTokens, formatCount, formatTimestampShort, formatUsd, statusColorForMode } from '../format';
import { BarChart } from '../components/BarChart';
import { DonutChart, DONUT_PALETTE } from '../components/DonutChart';
import { ModelIcon } from '../components/ModelIcon';
import { Modal } from '../components/Modal';
import type { GravityBoxStore } from '../hooks/useGravityBox';
import type { UsageBreakdownData, UsagePeriodData } from '../types';

const PERIODS = ['today', '7d', '30d', 'all'] as const;
type BreakdownTab = 'models' | 'projects' | 'conversations';
type BreakdownSort = 'tokens' | 'cost' | 'recent';

export const UsagePage: React.FC<{ store: GravityBoxStore }> = ({ store }) => {
  const { t, reachable, status, statusLabel } = store;
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>('today');
  const [data, setData] = useState<UsagePeriodData | null>(null);
  const [breakdown, setBreakdown] = useState<UsageBreakdownData | null>(null);
  const [activeTab, setActiveTab] = useState<BreakdownTab>('models');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [sortBy, setSortBy] = useState<BreakdownSort>('tokens');
  const [projectQuery, setProjectQuery] = useState('');
  const [convQuery, setConvQuery] = useState('');
  const [expandedConvId, setExpandedConvId] = useState<string | null>(null);
  const [visibleConvCount, setVisibleConvCount] = useState(50);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [logFilter, setLogFilter] = useState<{ dbFiles?: string[]; title?: string } | null>(null);
  const [showPricingModal, setShowPricingModal] = useState(false);
  const fetchSeqRef = useRef(0);

  const fetchUsage = useCallback(
    async (force = false) => {
      const seq = ++fetchSeqRef.current;
      setLoading(true);
      try {
        const res = await ipcRequest<UsagePeriodData & { ok?: boolean }>('usage_summary', {
          period,
          force,
        });
        if (seq !== fetchSeqRef.current) return;
        setData(res);
        try {
          const bd = await ipcRequest<UsageBreakdownData & { ok?: boolean }>('usage_breakdown', {
            period,
            force: false,
            snapshotId: res.snapshotId,
          });
          if (seq !== fetchSeqRef.current) return;
          setBreakdown(bd);
          setSelectedProjectId((prev) =>
            prev !== 'all' && !(bd.projects ?? []).some((p) => p.id === prev) ? 'all' : prev,
          );
        } catch {
          if (seq === fetchSeqRef.current) setBreakdown(null);
        }
      } catch (err) {
        if (force && seq === fetchSeqRef.current) store.showToast(String(err), true);
      } finally {
        if (seq === fetchSeqRef.current) setLoading(false);
      }
    },
    [period, store],
  );

  useEffect(() => {
    void fetchUsage(false);
  }, [fetchUsage]);

  useEffect(() => {
    setVisibleConvCount(50);
    setExpandedConvId(null);
  }, [period, selectedProjectId, convQuery, sortBy]);

  const handleExport = async () => {
    if (!data || loading || exporting || data.period !== period) return;
    setExporting(true);
    try {
      const defaultName = t(
        'usage.models.export_filename',
        { period },
        `gravitybox-usage-${period}-${new Date().toISOString().slice(0, 10)}.json`,
      );
      const exportPayload = {
        ...data,
        ...(breakdown && breakdown.period === period ? { breakdown } : {}),
      };
      const res = await saveJsonFile({
        defaultName,
        content: JSON.stringify(exportPayload, null, 2),
        title: store.locale === 'en' ? 'Export Usage Data' : '导出用量数据',
        filterLabel: store.locale === 'en' ? 'JSON Files' : 'JSON 文件',
        allFilesLabel: store.locale === 'en' ? 'All Files' : '所有文件',
      });
      if (res.saved) {
        store.showToast(t('usage_log.export.done', undefined, '用量记录已导出'));
      }
    } catch (err) {
      store.showToast(
        t('usage_log.export.failed', { error: String(err) }, `导出失败：${String(err)}`),
        true,
      );
    } finally {
      setExporting(false);
    }
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
  const dotColor = statusColorForMode(status?.mode, reachable);

  const activeProjects = useMemo(() => {
    const list = breakdown?.period === period ? breakdown.projects : [];
    const q = projectQuery.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.workspacePath && p.workspacePath.toLowerCase().includes(q)),
        )
      : list;
    return [...filtered].sort((a, b) => {
      if (sortBy === 'cost') return b.estimatedUsd - a.estimatedUsd || b.totalTokens - a.totalTokens;
      if (sortBy === 'recent') return b.lastActiveAt - a.lastActiveAt || b.totalTokens - a.totalTokens;
      return b.totalTokens - a.totalTokens || b.estimatedUsd - a.estimatedUsd;
    });
  }, [breakdown, period, projectQuery, sortBy]);

  const selectedProject = useMemo(() => {
    if (selectedProjectId === 'all' || breakdown?.period !== period) return null;
    return breakdown.projects.find((p) => p.id === selectedProjectId) ?? null;
  }, [breakdown, period, selectedProjectId]);

  const activeConversations = useMemo(() => {
    const list = breakdown?.period === period ? breakdown.conversations : [];
    const q = convQuery.trim().toLowerCase();
    const filtered = list.filter((c) => {
      if (selectedProjectId !== 'all' && c.projectId !== selectedProjectId) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.projectName.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      );
    });
    return [...filtered].sort((a, b) => {
      if (sortBy === 'cost') return b.estimatedUsd - a.estimatedUsd || b.totalTokens - a.totalTokens;
      if (sortBy === 'recent') return b.lastActiveAt - a.lastActiveAt || b.totalTokens - a.totalTokens;
      return b.totalTokens - a.totalTokens || b.lastActiveAt - a.lastActiveAt;
    });
  }, [breakdown, convQuery, period, selectedProjectId, sortBy]);

  const visibleConversations = activeConversations.slice(0, visibleConvCount);
  const convDenominator = selectedProject ? selectedProject.totalTokens : totalTokens;

  const breakdownCountLabel =
    activeTab === 'models'
      ? t('overview.bento.n_models', { count: byModel.length })
      : activeTab === 'projects'
        ? t('usage.breakdown.count_projects', { count: activeProjects.length }, `${activeProjects.length} 个项目`)
        : t('usage.breakdown.count_conversations', { count: activeConversations.length }, `${activeConversations.length} 个对话`);

  return (
    <>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 className="page-title">{t('usage.title')}</h1>
          <span className="badge neutral" style={{ padding: '4px 10px', gap: 6 }}>
            <span className={`status-dot ${dotColor}`} />
            {statusLabel}
          </span>
        </div>
        <div className="page-actions">
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
          <button
            className="btn"
            onClick={() => void handleExport()}
            disabled={!data || loading || exporting || data.period !== period}
          >
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
              <button className="btn btn-sm" onClick={() => setLogFilter({})}>
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

        {/* Breakdown Card: By Model / By Project / By Conversation */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div className="segmented" role="tablist" aria-label={t('usage.section.model_breakdown')}>
              <button
                className={`segmented-btn ${activeTab === 'models' ? 'active' : ''}`}
                onClick={() => setActiveTab('models')}
              >
                {t('usage.tab.models', undefined, '按模型')}
              </button>
              <button
                className={`segmented-btn ${activeTab === 'projects' ? 'active' : ''}`}
                onClick={() => setActiveTab('projects')}
              >
                {t('usage.tab.projects', undefined, '按项目')}
              </button>
              <button
                className={`segmented-btn ${activeTab === 'conversations' ? 'active' : ''}`}
                onClick={() => setActiveTab('conversations')}
              >
                {t('usage.tab.conversations', undefined, '按对话')}
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {breakdownCountLabel}
              </span>
              {activeTab !== 'models' && (
                <select
                  className="select"
                  style={{ height: 26, fontSize: 12 }}
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as BreakdownSort)}
                >
                  <option value="tokens">{t('usage.breakdown.sort.tokens', undefined, '按 Token')}</option>
                  <option value="cost">{t('usage.breakdown.sort.cost', undefined, '按费用')}</option>
                  <option value="recent">{t('usage.breakdown.sort.recent', undefined, '最近活跃')}</option>
                </select>
              )}
            </div>
          </div>

          {activeTab === 'models' && (
            byModel.length === 0 ? (
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
            )
          )}

          {activeTab === 'projects' && (
            <>
              <div className="breakdown-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 180 }}>
                  <Search size={13} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                  <input
                    className="input"
                    style={{ width: '100%', height: 28 }}
                    placeholder={t('usage.breakdown.search_projects', undefined, '搜索项目名称或路径…')}
                    value={projectQuery}
                    onChange={(e) => setProjectQuery(e.target.value)}
                  />
                </div>
              </div>

              {activeProjects.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
                  {t('usage.breakdown.empty_projects', undefined, '当前时段暂无项目用量记录')}
                </div>
              ) : (
                <div className="list-card" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
                  {activeProjects.map((p) => {
                    const share = totalTokens > 0 ? Math.round((p.totalTokens / totalTokens) * 100) : 0;
                    return (
                      <div
                        key={p.id}
                        className="list-row clickable"
                        onClick={() => {
                          setSelectedProjectId(p.id);
                          setActiveTab('conversations');
                        }}
                      >
                        <div className="list-row-left" style={{ flex: 1 }}>
                          <span className="icon-tile"><Folder size={15} /></span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span style={{ fontWeight: 600 }}>{p.name}</span>
                              {p.topModels.slice(0, 2).map((tm) => (
                                <span key={tm.model} className="badge neutral" style={{ fontWeight: 500 }}>
                                  {tm.model}
                                </span>
                              ))}
                            </div>
                            {p.workspacePath && (
                              <div className="project-path" title={p.workspacePath}>
                                {p.workspacePath}
                              </div>
                            )}
                            <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>
                              {t(
                                'usage.breakdown.project_meta',
                                {
                                  conversations: formatCount(p.conversationCount),
                                  requests: formatCount(p.requestCount),
                                  cacheRate: p.cacheHitRate.toFixed(1),
                                },
                                `${p.conversationCount} 个对话 · ${p.requestCount} 次请求 · 缓存命中 ${p.cacheHitRate.toFixed(1)}%`,
                              )}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                          <div style={{ textAlign: 'right' }}>
                            <div className="tabular" style={{ fontWeight: 700 }}>
                              {p.estimatedUsd > 0 ? formatUsd(p.estimatedUsd) : '--'}
                            </div>
                            <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                              {formatCompactTokens(p.totalTokens)} · {share}%
                            </div>
                          </div>
                          <ChevronRight size={14} style={{ color: 'var(--text-tertiary)' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {activeTab === 'conversations' && (
            <>
              <div className="breakdown-toolbar">
                <select
                  className="select"
                  style={{ height: 28, maxWidth: 220 }}
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                >
                  <option value="all">{t('usage.breakdown.all_projects', undefined, '全部项目')}</option>
                  {(breakdown?.period === period ? breakdown.projects : []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 180 }}>
                  <Search size={13} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                  <input
                    className="input"
                    style={{ width: '100%', height: 28 }}
                    placeholder={t('usage.breakdown.search_conversations', undefined, '搜索对话标题或项目…')}
                    value={convQuery}
                    onChange={(e) => setConvQuery(e.target.value)}
                  />
                </div>
              </div>

              {selectedProject && (
                <div className="card-subtle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{selectedProject.name}</div>
                    <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                      {formatCompactTokens(selectedProject.totalTokens)} Token · {formatUsd(selectedProject.estimatedUsd)} ·{' '}
                      {t(
                        'usage.breakdown.project_meta',
                        {
                          conversations: formatCount(selectedProject.conversationCount),
                          requests: formatCount(selectedProject.requestCount),
                          cacheRate: selectedProject.cacheHitRate.toFixed(1),
                        },
                        `${selectedProject.conversationCount} 个对话 · ${selectedProject.requestCount} 次请求 · 缓存命中 ${selectedProject.cacheHitRate.toFixed(1)}%`,
                      )}
                    </div>
                  </div>
                  <button className="btn btn-sm" onClick={() => setSelectedProjectId('all')}>
                    {t('usage.breakdown.clear_project_filter', undefined, '查看全部项目')}
                  </button>
                </div>
              )}

              {activeConversations.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>
                  {t('usage.breakdown.empty_conversations', undefined, '当前时段暂无对话用量记录')}
                </div>
              ) : (
                <>
                  <div className="list-card" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
                    {visibleConversations.map((c) => {
                      const isExpanded = expandedConvId === c.id;
                      const share = convDenominator > 0 ? Math.round((c.totalTokens / convDenominator) * 100) : 0;
                      return (
                        <div key={c.id} className="list-group">
                          <div
                            className="list-row clickable"
                            onClick={() => setExpandedConvId(isExpanded ? null : c.id)}
                          >
                            <div className="list-row-left" style={{ flex: 1 }}>
                              <span className="icon-tile purple"><MessageSquare size={15} /></span>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {c.title}
                                  </span>
                                  {selectedProjectId === 'all' && (
                                    <span className="badge neutral">{c.projectName}</span>
                                  )}
                                  {c.subagentCount > 0 && (
                                    <span className="badge">
                                      {t('usage.breakdown.subagents', { count: c.subagentCount }, `+${c.subagentCount} 子智能体`)}
                                    </span>
                                  )}
                                </div>
                                <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                                  {t(
                                    'usage.breakdown.conv_meta',
                                    {
                                      time: c.lastActiveAt > 0 ? formatTimestampShort(c.lastActiveAt) : '--',
                                      requests: formatCount(c.requestCount),
                                      cacheRate: c.cacheHitRate.toFixed(1),
                                    },
                                    `${c.lastActiveAt > 0 ? formatTimestampShort(c.lastActiveAt) : '--'} · ${c.requestCount} 次请求 · 缓存命中 ${c.cacheHitRate.toFixed(1)}%`,
                                  )}
                                </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                              <div style={{ textAlign: 'right' }}>
                                <div className="tabular" style={{ fontWeight: 700 }}>
                                  {c.estimatedUsd > 0 ? formatUsd(c.estimatedUsd) : '--'}
                                </div>
                                <div className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                                  {formatCompactTokens(c.totalTokens)} · {share}%
                                </div>
                              </div>
                              {isExpanded ? (
                                <ChevronDown size={14} style={{ color: 'var(--text-secondary)' }} />
                              ) : (
                                <ChevronRight size={14} style={{ color: 'var(--text-tertiary)' }} />
                              )}
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="conv-detail">
                              <div className="detail-metric-grid">
                                <div className="detail-metric-box">
                                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                    {t('usage.breakdown.detail.input', undefined, '未缓存输入')}
                                  </div>
                                  <div className="tabular" style={{ fontWeight: 600, fontSize: 12.5 }}>
                                    {formatCompactTokens(c.inputTokens)}
                                  </div>
                                </div>
                                <div className="detail-metric-box">
                                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                    {t('usage.breakdown.detail.cached', undefined, '缓存读取')}
                                  </div>
                                  <div className="tabular" style={{ fontWeight: 600, fontSize: 12.5 }}>
                                    {formatCompactTokens(c.cachedTokens)}
                                  </div>
                                </div>
                                {c.cacheWriteTokens > 0 && (
                                  <div className="detail-metric-box">
                                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                      {t('usage.breakdown.detail.cache_write', undefined, '缓存写入')}
                                    </div>
                                    <div className="tabular" style={{ fontWeight: 600, fontSize: 12.5 }}>
                                      {formatCompactTokens(c.cacheWriteTokens)}
                                    </div>
                                  </div>
                                )}
                                <div className="detail-metric-box">
                                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                    {t('usage.breakdown.detail.output', undefined, '输出')}
                                  </div>
                                  <div className="tabular" style={{ fontWeight: 600, fontSize: 12.5 }}>
                                    {formatCompactTokens(c.outputTokens)}
                                  </div>
                                </div>
                              </div>

                              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                                  {t('usage.breakdown.detail.models', undefined, '该对话模型分布')}
                                </div>
                                {c.byModel.map((m) => (
                                  <div
                                    key={m.model}
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      fontSize: 12,
                                      padding: '3px 0',
                                    }}
                                  >
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                                      <ModelIcon name={m.model} size={13} />
                                      {m.model}
                                    </span>
                                    <span className="tabular" style={{ color: 'var(--text-secondary)' }}>
                                      {formatCompactTokens(m.totalTokens)} Token · {formatCount(m.requestCount)}{' '}
                                      {store.locale === 'en' ? 'reqs' : '次'} · {m.estimatedUsd > 0 ? formatUsd(m.estimatedUsd) : '--'}
                                    </span>
                                  </div>
                                ))}
                              </div>

                              {c.dbFiles.length > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                  <button
                                    className="btn btn-sm"
                                    onClick={() => setLogFilter({ dbFiles: c.dbFiles, title: c.title })}
                                  >
                                    <ListFilter size={12} />
                                    {t('usage.breakdown.view_requests', undefined, '查看该对话请求明细…')}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {activeConversations.length > visibleConvCount && (
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => setVisibleConvCount((prev) => prev + 50)}
                      >
                        {t(
                          'usage.breakdown.show_more',
                          { remaining: activeConversations.length - visibleConvCount },
                          `显示更多（还有 ${activeConversations.length - visibleConvCount} 条）`,
                        )}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {logFilter !== null && (
        <UsageLogModal
          store={store}
          period={period}
          dbFiles={logFilter.dbFiles}
          subtitle={logFilter.title}
          onClose={() => setLogFilter(null)}
        />
      )}

      {showPricingModal && (
        <PricingSyncModal
          store={store}
          onClose={() => setShowPricingModal(false)}
          onRevalued={() => void fetchUsage(true)}
        />
      )}
    </>
  );
};

const UsageLogModal: React.FC<{
  store: GravityBoxStore;
  period: string;
  dbFiles?: string[];
  subtitle?: string;
  onClose: () => void;
}> = ({ store, period, dbFiles, subtitle, onClose }) => {
  const { t } = store;
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const snapshotIdRef = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const limit = 40;
  const dbFilesKey = dbFiles ? dbFiles.join('|') : '';

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const res = await ipcRequest<{
          rows?: Array<Record<string, unknown>>;
          events?: Array<Record<string, unknown>>;
          total?: number;
          snapshot_id?: string;
          snapshotId?: string;
        }>('usage_events', {
          period,
          query,
          offset,
          limit,
          ...(dbFiles && dbFiles.length > 0 ? { dbFiles } : {}),
          snapshotId: snapshotIdRef.current,
          pinSnapshot: !snapshotIdRef.current,
        });
        if (!active) return;
        setEvents(res.rows ?? res.events ?? []);
        setTotal(res.total ?? 0);
        const sid = res.snapshot_id ?? res.snapshotId;
        if (sid && !snapshotIdRef.current) {
          snapshotIdRef.current = sid;
        }
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
  }, [offset, period, query, dbFilesKey]);

  useEffect(() => {
    return () => {
      if (snapshotIdRef.current) {
        void ipcRequest('usage_snapshot_release', { snapshotId: snapshotIdRef.current }).catch(() => {});
        snapshotIdRef.current = undefined;
      }
    };
  }, []);

  const baseTitle = t('usage_log.title', undefined, '请求明细');
  const modalTitle = subtitle ? `${baseTitle} · ${subtitle}` : baseTitle;

  return (
    <Modal
      title={modalTitle}
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

interface PricingRowItem {
  id: string;
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  status?: string;
}

const PricingSyncModal: React.FC<{
  store: GravityBoxStore;
  onClose: () => void;
  onRevalued?: () => void;
}> = ({ store, onClose, onRevalued }) => {
  const { t } = store;
  const [models, setModels] = useState<PricingRowItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [preview, setPreview] = useState<{
    previewId?: string;
    changedCount?: number;
    affectedCount?: number;
    before?: number;
    after?: number;
    unverifiableCount?: number;
  } | null>(null);

  const loadCatalog = useCallback(async () => {
    try {
      const res = await ipcRequest<{
        prices?: Record<string, { model?: string; input?: number; output?: number; cached?: number; cacheWrite?: number }>;
        pricingStatus?: Record<string, string>;
        models?: Array<{
          id: string;
          input?: number;
          output?: number;
          cached?: number;
          cacheWrite?: number;
          inputPerMillion?: number;
          outputPerMillion?: number;
          cachedPerMillion?: number;
        }>;
        pricing?: Record<string, { inputPerMillion?: number; outputPerMillion?: number; cachedPerMillion?: number }>;
      }>('api_pricing_get');
      if (res.prices && typeof res.prices === 'object') {
        const statuses = res.pricingStatus ?? {};
        setModels(
          Object.entries(res.prices).map(([id, p]) => ({
            id,
            input: p.input,
            output: p.output,
            cached: p.cached,
            cacheWrite: p.cacheWrite,
            status: statuses[id],
          })),
        );
      } else if (Array.isArray(res.models)) {
        setModels(
          res.models.map((m) => ({
            id: m.id,
            input: m.input ?? m.inputPerMillion,
            output: m.output ?? m.outputPerMillion,
            cached: m.cached ?? m.cachedPerMillion,
            cacheWrite: m.cacheWrite,
          })),
        );
      } else if (res.pricing) {
        setModels(
          Object.entries(res.pricing).map(([id, p]) => ({
            id,
            input: p.inputPerMillion,
            output: p.outputPerMillion,
            cached: p.cachedPerMillion,
          })),
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
      const res = await ipcRequest<{
        synced?: boolean;
        error?: string;
        count?: number;
        appliedCount?: number;
      }>('pricing_sync_check');
      await loadCatalog();
      if (res.synced === false) {
        store.showToast(res.error || t('settings.pricing_sync.update_failed'), true);
      } else {
        store.showToast(
          t('settings.pricing_sync.synced', { count: res.count ?? res.appliedCount ?? models.length }),
        );
      }
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setSyncing(false);
    }
  };

  const handleRevaluePreview = async () => {
    try {
      const res = await ipcRequest<{
        preview?: {
          previewId?: string;
          changedCount?: number;
          affectedCount?: number;
          before?: number;
          after?: number;
          unverifiableCount?: number;
        };
      }>('api_pricing_revalue_preview', { mode: 'unpriced_only' });
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
      onRevalued?.();
    } catch (err) {
      store.showToast(String(err), true);
    }
  };

  const changedCount = preview?.changedCount ?? preview?.affectedCount ?? 0;

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
            <RefreshCw size={12} className={syncing ? 'spin' : ''} />
            {t('settings.pricing_sync.check_now')}
          </button>
          <button className="btn btn-primary" onClick={onClose}>{t('common.ok')}</button>
        </>
      }
    >
      {preview && (
        <div className="card-subtle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12 }}>
            {store.locale === 'en'
              ? `Will update ${changedCount} records${typeof preview.before === 'number' && typeof preview.after === 'number' ? ` (${formatUsd(preview.before)} → ${formatUsd(preview.after)})` : ''}`
              : `可更新 ${changedCount} 条未计价记录${typeof preview.before === 'number' && typeof preview.after === 'number' ? `（${formatUsd(preview.before)} → ${formatUsd(preview.after)}）` : ''}`}
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => void handleRevalueExecute()}>
            {store.locale === 'en' ? 'Apply' : '确认应用'}
          </button>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {models.map((m) => (
          <div key={m.id} className="card-subtle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              <ModelIcon name={m.id} size={13} />
              {m.id}
            </span>
            <span className="tabular" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              In ${m.input ?? '--'} · Cache ${m.cached ?? '--'}
              {typeof m.cacheWrite === 'number' ? ` · Write $${m.cacheWrite}` : ''} · Out ${m.output ?? '--'} / 1M
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
};
