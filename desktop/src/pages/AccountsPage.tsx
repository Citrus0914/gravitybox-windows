import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Sliders,
  Sparkles,
  Check,
  RotateCcw,
  ArrowUp,
  ArrowDown,
  Copy,
  Edit3,
  Trash2,
} from 'lucide-react';
import { ipcRequest, openExternalUrl } from '../ipc';
import { extractQuotaBars, formatTimestampShort } from '../format';
import { QuotaBar } from '../components/QuotaBar';
import { Modal } from '../components/Modal';
import { useAccountSwitch } from '../hooks/useAccountSwitch';
import type { GravityBoxStore } from '../hooks/useGravityBox';
import type { AccountItem, AutoSwitchConfig } from '../types';

export const AccountsPage: React.FC<{ store: GravityBoxStore }> = ({ store }) => {
  const { t, reachable } = store;
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [pendingSwitch, setPendingSwitch] = useState(false);
  const [collapsedAll, setCollapsedAll] = useState(Boolean(store.config?.accountsCollapsed));
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [autoSwitch, setAutoSwitch] = useState<AutoSwitchConfig>({
    enabled: false,
    strategy: 'priority',
    monitoredGroup: 'gemini_all',
    reserveThresholdPct: 10,
    candidateMinPct: 30,
  });
  const [recommendation, setRecommendation] = useState<{
    shouldSwitch?: boolean;
    bestCandidate?: AccountItem | null;
    reason?: string;
  } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const [listRes, cfgRes, recRes] = await Promise.all([
        ipcRequest<{
          activeId?: string | null;
          currentAccountId?: string | null;
          accounts?: AccountItem[];
          pendingSwitch?: boolean;
        }>('account_list'),
        ipcRequest<{ config?: AutoSwitchConfig }>('auto_switch_get').catch(() => null),
        ipcRequest<{
          shouldSwitch?: boolean;
          bestCandidate?: AccountItem | null;
          reason?: string;
        }>('auto_switch_best', { preview: true }).catch(() => null),
      ]);
      const list = listRes.accounts ?? [];
      setAccounts(list);
      setActiveId(listRes.activeId || listRes.currentAccountId || '');
      setPendingSwitch(Boolean(listRes.pendingSwitch));
      if (cfgRes?.config) setAutoSwitch(cfgRes.config);
      if (recRes) setRecommendation(recRes);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
    const timer = window.setInterval(() => void loadAccounts(), 10000);
    return () => window.clearInterval(timer);
  }, [loadAccounts]);

  useEffect(() => {
    const closeMenu = () => setMenuOpenId(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  const { requestSwitch, switchModal } = useAccountSwitch(store, () => {
    void loadAccounts();
  });

  const handleToggleCollapseAll = async () => {
    const next = !collapsedAll;
    setCollapsedAll(next);
    setExpandedIds({});
    await store.updateConfig({ accountsCollapsed: next }).catch(() => {});
  };

  const isExpanded = (id: string) => {
    if (id in expandedIds) return expandedIds[id];
    return !collapsedAll;
  };

  const handleRefreshAll = async () => {
    if (refreshingAll) return;
    setRefreshingAll(true);
    try {
      await ipcRequest('quota_refresh_all');
      await loadAccounts();
      store.showToast(t('main.quota.read_ok', undefined, 'Quota refreshed'));
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setRefreshingAll(false);
    }
  };

  const handleRefreshSingle = async (id: string) => {
    setRefreshingId(id);
    try {
      await ipcRequest('quota_refresh', { id });
      await loadAccounts();
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setRefreshingId(null);
    }
  };

  const handleToggleSmartSwitch = async (enabled: boolean) => {
    const next = { ...autoSwitch, enabled };
    setAutoSwitch(next);
    try {
      const res = await ipcRequest<{ config?: AutoSwitchConfig }>('auto_switch_set', { config: next });
      if (res.config) setAutoSwitch(res.config);
      store.showToast(
        enabled ? t('accounts.smart_switch.enabled_msg') : t('accounts.smart_switch.disabled_msg'),
      );
      void loadAccounts();
    } catch (err) {
      setAutoSwitch(autoSwitch);
      store.showToast(t('accounts.smart_switch.save_failed', { error: String(err) }), true);
    }
  };

  const handleMove = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= accounts.length) return;
    const copy = [...accounts];
    const [moved] = copy.splice(index, 1);
    copy.splice(target, 0, moved);
    setAccounts(copy);
    try {
      await ipcRequest('account_reorder', { ids: copy.map((a) => a.id) });
    } catch (err) {
      store.showToast(String(err), true);
      void loadAccounts();
    }
  };

  const handleDelete = async (acc: AccountItem) => {
    try {
      await ipcRequest('account_delete', { id: acc.id });
      await loadAccounts();
    } catch (err) {
      store.showToast(String(err), true);
    }
  };

  const handleRollbackRecovery = async () => {
    try {
      await ipcRequest('account_switch_rollback');
      await loadAccounts();
      store.showToast(t('accounts.rollback_btn'));
    } catch (err) {
      store.showToast(String(err), true);
    }
  };

  const monitoredKey = autoSwitch.monitoredGroup || 'gemini_all';
  const monitoredLabel = t(
    `accounts.smart_switch.monitored.${monitoredKey}`,
    undefined,
    monitoredKey,
  );
  const reservePct = autoSwitch.reserveThresholdPct ?? 10;
  const minPct = autoSwitch.candidateMinPct ?? 30;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('accounts.title')}</h1>
        <div className="page-actions">
          <button className="btn" onClick={() => void handleToggleCollapseAll()}>
            {collapsedAll ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            {collapsedAll ? t('accounts.expand_all') : t('accounts.collapse_all')}
          </button>
          <button className="btn" onClick={() => void handleRefreshAll()} disabled={!reachable || refreshingAll}>
            <RefreshCw size={13} />
            {t('common.refresh_quota')}
          </button>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)} disabled={!reachable}>
            <Plus size={14} />
            {t('accounts.add_btn')}
          </button>
        </div>
      </div>

      <div className="page-scroll">
        {pendingSwitch && (
          <div className="card" style={{ borderColor: 'var(--amber)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--amber)', fontWeight: 600 }}>
              {t('accounts.pending_recovery')}
            </span>
            <button className="btn btn-sm" onClick={() => void handleRollbackRecovery()}>
              <RotateCcw size={12} />
              {t('accounts.rollback_btn')}
            </button>
          </div>
        )}

        {/* Smart Switch Card */}
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <span className="icon-tile"><Sparkles size={16} /></span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700 }}>{t('accounts.smart_switch.title')}</span>
                <span className={`badge ${autoSwitch.enabled ? 'green' : 'neutral'}`}>
                  {autoSwitch.enabled
                    ? t('accounts.smart_switch.enabled_badge', { threshold: reservePct })
                    : t('accounts.smart_switch.disabled')}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('accounts.smart_switch.subtitle', {
                  monitored: monitoredLabel,
                  threshold: reservePct,
                  min: minPct,
                })}
              </div>
              {autoSwitch.enabled && recommendation?.shouldSwitch && recommendation.bestCandidate && (
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="badge amber">
                    {t('accounts.smart_switch.recommend_low', {
                      display: recommendation.bestCandidate.name || recommendation.bestCandidate.email,
                    })}
                  </span>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() =>
                      void requestSwitch(
                        recommendation.bestCandidate!.id,
                        recommendation.bestCandidate!.email,
                        recommendation.bestCandidate!.name,
                      )
                    }
                  >
                    {t('accounts.switch_recommended_btn')}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <button className="btn btn-sm" onClick={() => setShowPolicyModal(true)}>
              <Sliders size={12} />
              {t('accounts.smart_switch.config_btn')}
            </button>
            <label className="switch" aria-label={t('accounts.smart_switch.a11y')}>
              <input
                type="checkbox"
                checked={Boolean(autoSwitch.enabled)}
                onChange={(e) => void handleToggleSmartSwitch(e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        {/* Account Cards */}
        {accounts.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>
            {t('assistant_account.no_snapshots')}
          </div>
        ) : (
          accounts.map((acc, idx) => {
            const isActive = acc.id === activeId;
            const expanded = isExpanded(acc.id);
            const bars = extractQuotaBars(acc, t);
            const updatedTs = acc.quotaLastUpdated || acc.quota_last_updated;
            const displayName = acc.name?.trim() || acc.email;

            return (
              <div key={acc.id} className={`card ${isActive ? 'active-border' : ''}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15, fontWeight: 700 }}>{displayName}</span>
                      {acc.subscription_tier && (
                        <span className="badge">{acc.subscription_tier}</span>
                      )}
                      {isActive && (
                        <span className="badge green">
                          <Check size={11} />
                          {t('status.connected')}
                        </span>
                      )}
                      {acc.credentialReadiness?.state && acc.credentialReadiness.state !== 'ready' && (
                        <span className="badge red">{acc.credentialReadiness.message || t('quota.msg.credential')}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {acc.email}
                      {!expanded && bars.length === 0 && ` ${t('accounts.collapsed_pending')}`}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {!isActive && (
                      <button
                        className="btn btn-sm"
                        onClick={() => void requestSwitch(acc.id, acc.email, acc.name)}
                      >
                        {t('accounts.switch_btn')}
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-icon"
                      title={t('common.refresh_quota')}
                      disabled={refreshingId === acc.id}
                      onClick={() => void handleRefreshSingle(acc.id)}
                    >
                      <RefreshCw size={14} />
                    </button>

                    <div className="dropdown-wrap" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="btn btn-ghost btn-icon"
                        aria-label={t('accounts.a11y.actions', { account: acc.email })}
                        onClick={() => setMenuOpenId(menuOpenId === acc.id ? null : acc.id)}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {menuOpenId === acc.id && (
                        <div className="dropdown-menu">
                          <button
                            className="dropdown-item"
                            onClick={() => {
                              setMenuOpenId(null);
                              setRenameTarget({ id: acc.id, name: acc.name || '' });
                            }}
                          >
                            <span>{t('common.rename', undefined, '重命名 / Rename')}</span>
                            <Edit3 size={13} />
                          </button>
                          <button
                            className="dropdown-item"
                            onClick={() => {
                              setMenuOpenId(null);
                              void navigator.clipboard.writeText(acc.email);
                              store.showToast(t('common.copy_full_email'));
                            }}
                          >
                            <span>{t('common.copy_full_email')}</span>
                            <Copy size={13} />
                          </button>
                          {idx > 0 && (
                            <button
                              className="dropdown-item"
                              onClick={() => { setMenuOpenId(null); void handleMove(idx, -1); }}
                            >
                              <span>{store.locale === 'en' ? 'Move Up' : '上移'}</span>
                              <ArrowUp size={13} />
                            </button>
                          )}
                          {idx < accounts.length - 1 && (
                            <button
                              className="dropdown-item"
                              onClick={() => { setMenuOpenId(null); void handleMove(idx, 1); }}
                            >
                              <span>{store.locale === 'en' ? 'Move Down' : '下移'}</span>
                              <ArrowDown size={13} />
                            </button>
                          )}
                          <div className="dropdown-sep" />
                          <button
                            className="dropdown-item danger"
                            onClick={() => { setMenuOpenId(null); void handleDelete(acc); }}
                          >
                            <span>{store.locale === 'en' ? 'Remove Account' : '删除账号'}</span>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </div>

                    <button
                      className="btn btn-ghost btn-icon"
                      onClick={() => setExpandedIds((prev) => ({ ...prev, [acc.id]: !expanded }))}
                      aria-label={expanded ? t('accounts.a11y.collapse_details', { account: acc.email }) : t('accounts.a11y.expand_details', { account: acc.email })}
                    >
                      {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div style={{ marginTop: 12 }}>
                    {bars.length > 0 ? (
                      <div className="grid-2" style={{ rowGap: 10, columnGap: 16 }}>
                        {bars.map((b) => (
                          <QuotaBar key={b.key} bar={b} />
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {acc.quota_refresh_error || t('quota.unknown')}
                      </div>
                    )}
                    {updatedTs ? (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 10 }}>
                        {t('common.updated_at', { time: formatTimestampShort(updatedTs) })}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {switchModal}

      {showAddModal && (
        <AddAccountModal
          store={store}
          onClose={() => setShowAddModal(false)}
          onAdded={() => void loadAccounts()}
        />
      )}

      {showPolicyModal && (
        <AutoSwitchPolicyModal
          store={store}
          initial={autoSwitch}
          onClose={() => setShowPolicyModal(false)}
          onSaved={(cfg) => {
            setAutoSwitch(cfg);
            void loadAccounts();
          }}
        />
      )}

      {renameTarget && (
        <Modal
          title={store.locale === 'en' ? 'Rename Account' : '重命名账号'}
          onClose={() => setRenameTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRenameTarget(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    await ipcRequest('account_rename', renameTarget);
                    setRenameTarget(null);
                    await loadAccounts();
                  } catch (err) {
                    store.showToast(String(err), true);
                  }
                }}
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <input
            className="input"
            value={renameTarget.name}
            onChange={(e) => setRenameTarget({ ...renameTarget, name: e.target.value })}
            autoFocus
          />
        </Modal>
      )}
    </>
  );
};

const AddAccountModal: React.FC<{
  store: GravityBoxStore;
  onClose: () => void;
  onAdded: () => void;
}> = ({ store, onClose, onAdded }) => {
  const { t } = store;
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');
  const [oauthId, setOauthId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState('');

  useEffect(() => {
    if (!oauthId) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await ipcRequest<{
          status?: string;
          error?: string;
          account?: AccountItem;
        }>('account_oauth_status', { id: oauthId });
        if (res.status === 'completed' || res.account) {
          window.clearInterval(timer);
          setOauthId(null);
          setBusy(false);
          onAdded();
          onClose();
        } else if (res.status === 'failed' || res.status === 'cancelled' || res.error) {
          window.clearInterval(timer);
          setOauthId(null);
          setBusy(false);
          setErrorText(res.error || t('add_account.error.incomplete'));
        }
      } catch {
        // keep polling
      }
    }, 1200);
    return () => {
      window.clearInterval(timer);
    };
  }, [oauthId, onAdded, onClose, t]);

  const handleClose = () => {
    if (oauthId) {
      void ipcRequest('account_oauth_cancel', { id: oauthId }).catch(() => {});
    }
    onClose();
  };

  const handleSaveCurrent = async () => {
    setBusy(true);
    setErrorText('');
    setStatusText(t('add_account.status.reading_current'));
    try {
      await ipcRequest('account_save_current');
      onAdded();
      onClose();
    } catch (err) {
      setErrorText(String(err));
    } finally {
      setBusy(false);
      setStatusText('');
    }
  };

  const handleOAuth = async () => {
    setBusy(true);
    setErrorText('');
    setStatusText(t('add_account.status.opening_google'));
    try {
      const res = await ipcRequest<{ id: string; url?: string; authUrl?: string }>('account_oauth_begin');
      const authUrl = res.url || res.authUrl;
      if (!authUrl) throw new Error(t('add_account.error.invalid_url'));
      await openExternalUrl(authUrl);
      setOauthId(res.id);
      setStatusText(t('add_account.status.complete_in_browser'));
    } catch (err) {
      setBusy(false);
      setStatusText('');
      setErrorText(String(err));
    }
  };

  const handleTokenImport = async () => {
    if (!refreshToken.trim()) return;
    setBusy(true);
    setErrorText('');
    setStatusText(t('add_account.status.saving'));
    try {
      const res = await ipcRequest<{ taskId: string }>('account_add_token_start', {
        refreshToken: refreshToken.trim(),
      });
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const list = await ipcRequest<{ tasks: Array<{ id: string; state: string; error?: string; result?: { message?: string } }> }>('task_list');
        const task = list.tasks?.find((x) => x.id === res.taskId);
        if (task && task.state !== 'running') {
          if (task.state === 'completed') {
            onAdded();
            onClose();
            return;
          }
          throw new Error(task.error || t('add_account.error.incomplete'));
        }
      }
      throw new Error(t('assistant.quota_refresh_timeout'));
    } catch (err) {
      setErrorText(String(err));
    } finally {
      setBusy(false);
      setStatusText('');
    }
  };

  return (
    <Modal
      title={t('add_account.title')}
      onClose={handleClose}
      footer={
        <button className="btn" onClick={handleClose}>
          {t('common.cancel')}
        </button>
      }
    >
      <div className="card-subtle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t('add_account.save_current')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('add_account.save_current_sub')}</div>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={() => void handleSaveCurrent()}>
          {t('add_account.save_current')}
        </button>
      </div>

      <div className="card-subtle" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t('add_account.google_title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('add_account.google_sub')}</div>
        </div>
        <button
          className="btn"
          disabled={busy || store.status?.oauthClientConfigured === false}
          onClick={() => void handleOAuth()}
        >
          {t('add_account.google_btn')}
        </button>
      </div>

      <div className="card-subtle" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontWeight: 600 }}>Refresh Token</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            type="password"
            placeholder="1//0..."
            value={refreshToken}
            onChange={(e) => setRefreshToken(e.target.value)}
          />
          <button className="btn" disabled={busy || !refreshToken.trim()} onClick={() => void handleTokenImport()}>
            {store.locale === 'en' ? 'Import' : '导入'}
          </button>
        </div>
      </div>

      {statusText && <div style={{ fontSize: 12, color: 'var(--accent)' }}>{statusText}</div>}
      {errorText && <div style={{ fontSize: 12, color: 'var(--red)' }}>{errorText}</div>}
    </Modal>
  );
};

const AutoSwitchPolicyModal: React.FC<{
  store: GravityBoxStore;
  initial: AutoSwitchConfig;
  onClose: () => void;
  onSaved: (cfg: AutoSwitchConfig) => void;
}> = ({ store, initial, onClose, onSaved }) => {
  const { t } = store;
  const [strategy, setStrategy] = useState(initial.strategy || 'priority');
  const [monitoredGroup, setMonitoredGroup] = useState(initial.monitoredGroup || 'gemini_all');
  const [reservePct, setReservePct] = useState(String(initial.reserveThresholdPct ?? 10));
  const [candidatePct, setCandidatePct] = useState(String(initial.candidateMinPct ?? 30));
  const [err, setErr] = useState('');

  const handleSave = async () => {
    const r = Number.parseInt(reservePct, 10);
    const c = Number.parseInt(candidatePct, 10);
    if (!Number.isInteger(r) || r < 1 || r > 98) {
      setErr(t('policy.error.reserve_range'));
      return;
    }
    if (!Number.isInteger(c) || c < 2 || c > 100) {
      setErr(t('policy.error.candidate_range'));
      return;
    }
    if (c <= r) {
      setErr(t('policy.error.candidate_le_reserve'));
      return;
    }
    try {
      const res = await ipcRequest<{ config?: AutoSwitchConfig }>('auto_switch_set', {
        config: {
          ...initial,
          strategy,
          monitoredGroup,
          reserveThresholdPct: r,
          candidateMinPct: c,
        },
      });
      onSaved(res.config ?? { ...initial, strategy, monitoredGroup, reserveThresholdPct: r, candidateMinPct: c });
      onClose();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <Modal
      title={t('policy.title')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={() => void handleSave()}>{t('common.save')}</button>
        </>
      }
    >
      <div className="list-row" style={{ padding: '6px 0' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t('policy.row.strategy.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('policy.row.strategy.sub')}</div>
        </div>
        <select className="select" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          <option value="priority">{t('policy.strategy.priority')}</option>
          <option value="round_robin">{t('policy.strategy.round_robin')}</option>
        </select>
      </div>

      <div className="list-row" style={{ padding: '6px 0' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t('policy.row.monitored.title')}</div>
        </div>
        <select className="select" value={monitoredGroup} onChange={(e) => setMonitoredGroup(e.target.value)}>
          <option value="gemini_all">{t('accounts.smart_switch.monitored.gemini_all')}</option>
          <option value="all_available">{t('accounts.smart_switch.monitored.all_available')}</option>
          <option value="all_core">{t('accounts.smart_switch.monitored.all_core')}</option>
          <option value="gemini_all_argon">{t('accounts.smart_switch.monitored.gemini_all_argon')}</option>
          <option value="gemini_base">{t('accounts.smart_switch.monitored.gemini_base')}</option>
        </select>
      </div>

      <div className="list-row" style={{ padding: '6px 0' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t('policy.row.reserve.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('policy.row.reserve.sub')}</div>
        </div>
        <input
          className="input tabular"
          style={{ width: 84, textAlign: 'right' }}
          type="number"
          min={1}
          max={98}
          value={reservePct}
          onChange={(e) => setReservePct(e.target.value)}
        />
      </div>

      <div className="list-row" style={{ padding: '6px 0' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{t('policy.row.candidate.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('policy.row.candidate.sub')}</div>
        </div>
        <input
          className="input tabular"
          style={{ width: 84, textAlign: 'right' }}
          type="number"
          min={2}
          max={100}
          value={candidatePct}
          onChange={(e) => setCandidatePct(e.target.value)}
        />
      </div>

      {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
};
