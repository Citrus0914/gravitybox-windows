import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  BarChart2,
  Settings,
  Info,
  ExternalLink,
} from 'lucide-react';
import { launchAntigravity } from '../ipc';
import { statusColorForMode } from '../format';
import { BrandLogo } from '../components/ModelIcon';
import { UsagePage } from '../pages/UsagePage';
import { SettingsPage } from '../pages/SettingsPage';
import { AboutPage } from '../pages/AboutPage';
import type { GravityBoxStore } from '../hooks/useGravityBox';

export const MainConsole: React.FC<{ store: GravityBoxStore }> = ({ store }) => {
  const { t, config, status, reachable, statusLabel } = store;
  const [page, setPage] = useState<number>(Math.min(2, Math.max(0, config?.lastPage ?? 0)));

  useEffect(() => {
    if (typeof config?.lastPage === 'number') {
      setPage(Math.min(2, Math.max(0, config.lastPage)));
    }
  }, [config?.lastPage]);

  useEffect(() => {
    const unlistenPromise = listen<number>('navigate-page', (ev) => {
      if (typeof ev.payload === 'number') {
        setPage(Math.min(2, Math.max(0, ev.payload)));
      }
    });
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, []);

  const selectPage = (next: number) => {
    const clamped = Math.min(2, Math.max(0, next));
    setPage(clamped);
    void store.updateConfig({ lastPage: clamped }).catch(() => {});
  };

  const navItems = [
    { id: 0, label: t('nav.usage'), Icon: BarChart2 },
    { id: 1, label: t('nav.settings'), Icon: Settings },
    { id: 2, label: t('nav.about'), Icon: Info },
  ];

  const dotColor = statusColorForMode(status?.mode, reachable);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label={t('nav.accessibility')}>
        <div className="brand-row">
          <BrandLogo size={22} />
          <span className="brand-title">GravityBox</span>
        </div>

        <nav className="nav-list">
          {navItems.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => selectPage(id)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="status-footnote">
            <span className={`status-dot ${dotColor}`} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {statusLabel}
            </span>
          </div>
          <button
            className="nav-item"
            style={{ width: '100%' }}
            onClick={() => void launchAntigravity().catch((err) => store.showToast(String(err), true))}
          >
            <ExternalLink size={15} />
            <span>{t('sidebar.open_antigravity')}</span>
          </button>
        </div>
      </aside>

      <main className="main-area">
        {page === 0 && <UsagePage store={store} />}
        {page === 1 && <SettingsPage store={store} />}
        {page === 2 && <AboutPage store={store} />}
      </main>
    </div>
  );
};
