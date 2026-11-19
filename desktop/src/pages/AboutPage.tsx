import React, { useState } from 'react';
import { Cpu, FolderOpen, Box, ArrowUpRight, RefreshCw } from 'lucide-react';
import { openExternalUrl, restartBackend, revealStateDir } from '../ipc';
import { BrandLogo } from '../components/ModelIcon';
import type { GravityBoxStore } from '../hooks/useGravityBox';

const RELEASES_URL = 'https://github.com/Enzoo404/gravitybox/releases';

export const AboutPage: React.FC<{ store: GravityBoxStore }> = ({ store }) => {
  const { t, config, runtime, status } = store;
  const [restarting, setRestarting] = useState(false);

  const handleRestartBackend = async () => {
    setRestarting(true);
    try {
      await restartBackend();
      await store.refreshStatus(true);
      store.showToast(t('status.connected'));
    } catch (err) {
      store.showToast(String(err), true);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('about.title')}</h1>
      </div>

      <div className="page-scroll">
        <div className="card list-card">
          <div className="list-row">
            <div className="list-row-left">
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 11,
                  background: 'var(--accent-soft)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <BrandLogo size={26} />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 700 }}>GravityBox</span>
                  <span className="badge">v{runtime?.version || '1.1.1'}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  Windows Desktop Edition · {store.statusLabel}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" disabled={restarting} onClick={() => void handleRestartBackend()}>
                <RefreshCw size={13} />
                {store.locale === 'en' ? 'Reconnect Service' : '重连后台'}
              </button>
              <button className="btn" onClick={() => void openExternalUrl(RELEASES_URL)}>
                {t('about.check_update')}
              </button>
            </div>
          </div>

          <div className="list-row">
            <span style={{ fontWeight: 500 }}>{t('about.auto_update')}</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(config?.autoUpdateEnabled)}
                onChange={(e) => void store.updateConfig({ autoUpdateEnabled: e.target.checked })}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>

        <div>
          <div className="section-label">{t('about.section.runtime')}</div>
          <div className="card list-card">
            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile purple"><Cpu size={16} /></span>
                <span>{t('about.target_app')}</span>
              </div>
              <span style={{ fontWeight: 600 }}>
                {status?.version ? `Antigravity ${status.version}` : t('about.antigravity_stable')}
              </span>
            </div>

            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile amber"><FolderOpen size={16} /></span>
                <span>{t('about.data_dir')}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 320,
                  }}
                  title={runtime?.stateDir}
                >
                  {runtime?.stateDir || '--'}
                </span>
                <button className="btn btn-sm" onClick={() => void revealStateDir()}>
                  {t('about.reveal_data')}
                </button>
              </div>
            </div>

            <div className="list-row">
              <div className="list-row-left">
                <span className="icon-tile"><Box size={16} /></span>
                <span>IPC Endpoint</span>
              </div>
              <span className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {runtime?.pipeEndpoint || '--'}
              </span>
            </div>
          </div>
        </div>

        <div className="card list-card">
          <div className="list-row">
            <div className="list-row-left">
              <span className="icon-tile"><Box size={16} /></span>
              <span style={{ fontWeight: 600 }}>GitHub Releases</span>
            </div>
            <button className="btn btn-sm" onClick={() => void openExternalUrl(RELEASES_URL)}>
              GitHub <ArrowUpRight size={12} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
