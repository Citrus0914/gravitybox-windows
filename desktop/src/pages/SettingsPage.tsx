import React, { useCallback, useEffect, useState } from 'react';
import {
  Globe,
  Activity,
  RefreshCw,
  DollarSign,
  Power,
  Link2,
  HardDrive,
  Sparkles,
  History,
  RotateCcw,
} from 'lucide-react';
import { ipcRequest, quitAntigravityAndWait, launchAntigravity, revealPath, setAutoStart } from '../ipc';
import { formatBytes, formatTimestampShort } from '../format';
import { Modal } from '../components/Modal';
import type { GravityBoxStore } from '../hooks/useGravityBox';
import type { MaintenanceScanResult } from '../types';

export const SettingsPage: React.FC<{ store: GravityBoxStore }> = ({ store }) => {
  const { t, config, runtime, status, reachable } = store;
  const [scan, setScan] = useState<MaintenanceScanResult | null>(null);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [checkingPricing, setCheckingPricing] = useState(false);

  const loadScan = useCallback(async (retentionDays = 7) => {
    try {
      const res = await ipcRequest<MaintenanceScanResult>('maintenance_scan', { retentionDays });
      setScan(res);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadScan(7);
  }, [loadScan]);

  const handlePricingSyncToggle = async (enabled: boolean) => {
    await store.updateConfig({ autoPricingSyncEnabled: enabled });
    try {
      await ipcRequest('pricing_sync_set', { enabled });
    } catch {
      store.showToast(t('settings.pricing_sync.update_failed'), true);
    }
  };

  const handleCheckPricingNow = async () => {
    setCheckingPricing(true);
    try {
      const res = await ipcRequest<{ appliedCount?: number }>('pricing_sync_check');
      store.showToast(t('settings.pricing_sync.synced', { count: res.appliedCount ?? 0 }));
    } catch (err) {
      store.showToast(t('settings.pricing_sync.sync_failed', { error: String(err) }), true);
    } finally {
      setCheckingPricing(false);
    }
  };

  const handleAutoStartToggle = async (enabled: boolean) => {
    try {
      await setAutoStart(enabled);
      await store.refreshRuntime();
    } catch (err) {
      store.showToast(String(err), true);
    }
  };

  const safeBytes = scan?.buckets?.runtimeCache?.clearableBytes ?? scan?.safeBytes ?? 0;
  const statefulBytes = scan?.buckets?.historyLogs?.clearableBytes ?? scan?.statefulBytes ?? 0;
  const hudEnabled = status?.hudEnabled ?? config?.hudEnabled ?? true;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('settings.title')}</h1>
      </div>

      <div className="page-scroll">
        {/* Section 1: Antigravity Enhancement */}
        <div>
          <div className="section-label">{t('settings.section.enhance')}</div>
          <div className="card list-card">
            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile green"><Globe size={16} /></span>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('settings.language.title')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t('settings.language.subtitle')}
                  </div>
                </div>
              </div>
              <select
                className="select"
                value={store.configuredLanguage}
                onChange={(e) => void store.setLanguage(e.target.value)}
              >
                <option value="system">{t('language.system')}</option>
                <option value="zh-Hans">简体中文</option>
                <option value="en">English</option>
              </select>
            </div>

            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile purple"><Activity size={16} /></span>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('settings.hud.title')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t('settings.hud.subtitle')}
                  </div>
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={Boolean(hudEnabled)}
                  onChange={(e) => void store.setHudEnabled(e.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>
          </div>
        </div>

        {/* Section 2: Quota & Pricing */}
        <div>
          <div className="section-label">{t('settings.section.quota_pricing')}</div>
          <div className="card list-card">
            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile"><RefreshCw size={16} /></span>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('settings.refresh.title')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t('settings.refresh.subtitle')}
                  </div>
                </div>
              </div>
              <select
                className="select"
                value={String(config?.quotaRefreshMinutes ?? 0)}
                onChange={(e) => void store.updateConfig({ quotaRefreshMinutes: Number(e.target.value) })}
              >
                <option value="0">{t('settings.refresh.manual')}</option>
                <option value="5">{t('settings.refresh.5m')}</option>
                <option value="10">{t('settings.refresh.10m')}</option>
                <option value="15">{t('settings.refresh.15m')}</option>
                <option value="30">{t('settings.refresh.30m')}</option>
                <option value="60">{t('settings.refresh.60m')}</option>
              </select>
            </div>

            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile"><DollarSign size={16} /></span>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('settings.pricing_sync.title')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t('settings.pricing_sync.subtitle')}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  className="btn btn-sm"
                  disabled={!reachable || checkingPricing}
                  onClick={() => void handleCheckPricingNow()}
                >
                  {t('settings.pricing_sync.check_now')}
                </button>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={Boolean(config?.autoPricingSyncEnabled)}
                    onChange={(e) => void handlePricingSyncToggle(e.target.checked)}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Section 3: System & Storage */}
        <div>
          <div className="section-label">{t('settings.section.system_storage')}</div>
          <div className="card list-card">
            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile gray"><Power size={16} /></span>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('settings.login.title')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t('settings.login.subtitle')}
                  </div>
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={Boolean(runtime?.autoStart)}
                  onChange={(e) => void handleAutoStartToggle(e.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>

            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile"><Link2 size={16} /></span>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('settings.sync_lifecycle.title')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t('settings.sync_lifecycle.subtitle')}
                  </div>
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={Boolean(config?.syncAntigravityLifecycle)}
                  onChange={(e) => void store.updateConfig({ syncAntigravityLifecycle: e.target.checked })}
                />
                <span className="switch-slider" />
              </label>
            </div>

            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile amber"><HardDrive size={16} /></span>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{t('settings.storage.title')}</span>
                    {scan && (
                      <span className={`badge ${safeBytes > 0 ? '' : 'green'}`}>
                        {safeBytes > 0
                          ? t('settings.storage.reclaimable', { size: formatBytes(safeBytes) })
                          : t('settings.storage.healthy')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {scan
                      ? t('settings.storage.detail_subtitle', {
                          safe: formatBytes(safeBytes),
                          stateful: formatBytes(statefulBytes),
                        })
                      : t('settings.storage.default_subtitle')}
                  </div>
                </div>
              </div>
              <button className="btn" onClick={() => setShowMaintenance(true)} disabled={!reachable}>
                {t('settings.storage.manage_btn')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showMaintenance && (
        <MaintenanceModal
          store={store}
          initialScan={scan}
          onClose={() => {
            setShowMaintenance(false);
            void loadScan(7);
          }}
        />
      )}
    </>
  );
};

const MaintenanceModal: React.FC<{
  store: GravityBoxStore;
  initialScan: MaintenanceScanResult | null;
  onClose: () => void;
}> = ({ store, initialScan, onClose }) => {
  const { t } = store;
  const [scan, setScan] = useState<MaintenanceScanResult | null>(initialScan);
  const [retentionDays, setRetentionDays] = useState(7);
  const [clearCache, setClearCache] = useState(true);
  const [clearLogs, setClearLogs] = useState(false);
  const [busy, setBusy] = useState(false);

  const rescan = useCallback(async (days: number) => {
    setBusy(true);
    try {
      const res = await ipcRequest<MaintenanceScanResult>('maintenance_scan', { retentionDays: days });
      setScan(res);
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setBusy(false);
    }
  }, [store]);

  const safeBytes = scan?.buckets?.runtimeCache?.clearableBytes ?? scan?.safeBytes ?? 0;
  const statefulBytes = scan?.buckets?.historyLogs?.clearableBytes ?? scan?.statefulBytes ?? 0;
  const coreBytes = scan?.protectedBytes ?? 0;
  const selectedBytes = (clearCache ? safeBytes : 0) + (clearLogs ? statefulBytes : 0);
  const totalDist = Math.max(1, safeBytes + statefulBytes + coreBytes);
  const snapshot = scan?.latestRestorableSnapshot;

  const handleClear = async () => {
    const scopes: string[] = [];
    if (clearCache) scopes.push('runtime_cache');
    if (clearLogs) scopes.push('history_logs');
    if (scopes.length === 0) return;

    setBusy(true);
    try {
      let relaunch = false;
      if (store.runtime?.antigravityRunning) {
        relaunch = await quitAntigravityAndWait();
        if (!relaunch) {
          store.showToast(t('maintenance.err.quit_before_clear', undefined, 'Please quit Antigravity first'), true);
          setBusy(false);
          return;
        }
      }
      await ipcRequest('maintenance_preflight').catch(() => {});
      const res = await ipcRequest<{ clearedBytes?: number; message?: string }>('maintenance_smart_clear', {
        scopes,
        retentionDays,
        keepLocalSnapshots: 1,
      });
      if (relaunch) {
        await launchAntigravity().catch(() => {});
      }
      store.showToast(
        res.message ||
          (store.locale === 'en'
            ? `Reclaimed ${formatBytes(res.clearedBytes ?? 0)}`
            : `已释放 ${formatBytes(res.clearedBytes ?? 0)}`),
      );
      await rescan(retentionDays);
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!snapshot?.id) return;
    setBusy(true);
    try {
      await ipcRequest('maintenance_restore', { snapshotId: snapshot.id });
      store.showToast(t('common.ok'));
      await rescan(retentionDays);
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('settings.storage.title')}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={() => void rescan(retentionDays)}>
            <RefreshCw size={12} />
            {t('common.refresh')}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {store.locale === 'en' ? 'Done' : '完成'}
          </button>
        </>
      }
    >
      <div className="card-subtle" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {store.locale === 'en' ? 'Selected Reclaimable Space' : '已选可释放空间'}
            </div>
            <div className="tabular" style={{ fontSize: 26, fontWeight: 700 }}>
              {formatBytes(selectedBytes)}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              {store.locale === 'en'
                ? 'Logins, chat history and billing records remain protected'
                : '账号登录、聊天记录与费用统计均受自动保护'}
            </div>
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || selectedBytes <= 0}
            onClick={() => void handleClear()}
          >
            {store.locale === 'en' ? 'Clean Now' : '一键清理'}
          </button>
        </div>

        <div style={{ display: 'flex', height: 7, borderRadius: 999, overflow: 'hidden', gap: 2 }}>
          <div style={{ width: `${(safeBytes / totalDist) * 100}%`, background: 'var(--accent)' }} />
          <div style={{ width: `${(statefulBytes / totalDist) * 100}%`, background: 'var(--amber)' }} />
          <div style={{ flex: 1, background: 'var(--border-strong)' }} />
        </div>

        <div style={{ display: 'flex', gap: 16, fontSize: 11.5, color: 'var(--text-secondary)' }}>
          <span>● {store.locale === 'en' ? 'Runtime Cache' : '运行缓存'} {formatBytes(safeBytes)}</span>
          <span>● {store.locale === 'en' ? 'Stale Logs' : '早期日志'} {formatBytes(statefulBytes)}</span>
          <span>● {store.locale === 'en' ? 'Core Data' : '核心数据'} {formatBytes(coreBytes)}</span>
        </div>
      </div>

      <div className="card list-card">
        <div className="list-row">
          <div className="list-row-left">
            <span className="icon-tile"><Sparkles size={15} /></span>
            <div>
              <div style={{ fontWeight: 600 }}>
                {store.locale === 'en' ? 'Application Runtime Cache' : '应用运行缓存'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {store.locale === 'en'
                  ? 'Temporary web, compile & crash leftovers; zero side effects'
                  : '临时网页、编译与崩溃残留，清理后零副作用'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="tabular" style={{ fontWeight: 700 }}>{formatBytes(safeBytes)}</span>
            <label className="switch">
              <input type="checkbox" checked={clearCache} onChange={(e) => setClearCache(e.target.checked)} />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        <div className="list-row">
          <div className="list-row-left">
            <span className="icon-tile amber"><History size={15} /></span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600 }}>
                  {store.locale === 'en' ? 'Old Background Logs' : '早期后台运行日志'}
                </span>
                <select
                  className="select"
                  style={{ height: 24, fontSize: 11.5 }}
                  value={retentionDays}
                  onChange={(e) => {
                    const days = Number(e.target.value);
                    setRetentionDays(days);
                    void rescan(days);
                  }}
                >
                  <option value={7}>{store.locale === 'en' ? '7+ days ago' : '7 天前'}</option>
                  <option value={14}>{store.locale === 'en' ? '14+ days ago' : '14 天前'}</option>
                  <option value={30}>{store.locale === 'en' ? '30+ days ago' : '30 天前'}</option>
                </select>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {store.locale === 'en'
                  ? 'Intermediate trace logs of old conversations; chats & bills preserved'
                  : '旧对话的后台中间过程，完整保留聊天记录与账单'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="tabular" style={{ fontWeight: 700 }}>{formatBytes(statefulBytes)}</span>
            <label className="switch">
              <input type="checkbox" checked={clearLogs} onChange={(e) => setClearLogs(e.target.checked)} />
              <span className="switch-slider" />
            </label>
          </div>
        </div>
      </div>

      {snapshot && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div className="list-row-left">
            <span className="icon-tile"><RotateCcw size={15} /></span>
            <div>
              <div style={{ fontWeight: 600 }}>
                {store.locale === 'en'
                  ? `Last cleanup freed ${formatBytes(snapshot.totalBytes)} (${formatTimestampShort(snapshot.at)})`
                  : `上次清理已释放 ${formatBytes(snapshot.totalBytes)} (${formatTimestampShort(snapshot.at)})`}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {store.locale === 'en'
                  ? 'Supports one-click in-place restore from snapshot'
                  : '支持一键原位还原上次清理内容'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void handleRestore()}>
              {store.locale === 'en' ? 'Undo Cleanup' : '撤回上次清理'}
            </button>
            {snapshot.snapshotPath && (
              <button className="btn btn-sm" onClick={() => void revealPath(snapshot.snapshotPath!)}>
                {t('maintenance.reveal_btn')}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};
