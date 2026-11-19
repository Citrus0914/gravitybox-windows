import React, { useCallback, useState } from 'react';
import { Modal } from '../components/Modal';
import { ipcRequest, launchAntigravity, quitAntigravityAndWait } from '../ipc';
import type { GravityBoxStore } from './useGravityBox';

interface SwitchPrompt {
  id: string;
  display: string;
  email: string;
  shouldQuitAndRelaunch: boolean;
  hasRunningTask: boolean;
  taskReason?: string;
}

export function useAccountSwitch(store: GravityBoxStore, onSwitched?: () => void) {
  const [prompt, setPrompt] = useState<SwitchPrompt | null>(null);
  const [switching, setSwitching] = useState(false);

  const requestSwitch = useCallback(
    async (id: string, email: string, name?: string) => {
      if (!id || switching) return;
      try {
        const pre = await ipcRequest<{
          appRunning?: boolean;
          stableRunning?: boolean;
          insidersRunning?: boolean;
          hasRunningTask?: boolean;
          safe?: boolean;
          taskReason?: string;
        }>('account_switch_preflight', { id });

        if (pre.insidersRunning) {
          store.showToast(store.t('assistant_account.insiders_running'), true);
          return;
        }
        const shouldQuitAndRelaunch = Boolean(
          !pre.insidersRunning && (pre.stableRunning || pre.appRunning || store.runtime?.antigravityRunning),
        );
        const hasRunningTask = Boolean(pre.hasRunningTask || pre.safe === false);
        const display =
          name && name.toLowerCase() !== email.toLowerCase() && email
            ? `${name} (${email})`
            : email || name || store.t('assistant_account.target_fallback');

        setPrompt({
          id,
          display,
          email,
          shouldQuitAndRelaunch,
          hasRunningTask,
          taskReason: pre.taskReason,
        });
      } catch (err) {
        store.showToast(
          store.t('assistant_account.preflight_failed', { error: String(err) }),
          true,
        );
      }
    },
    [store, switching],
  );

  const confirmSwitch = useCallback(async () => {
    if (!prompt || switching) return;
    const target = prompt;
    setSwitching(true);
    try {
      if (target.shouldQuitAndRelaunch) {
        const exited = await quitAntigravityAndWait();
        if (!exited) {
          store.showToast(store.t('assistant_account.quit_first'), true);
          setSwitching(false);
          return;
        }
      }
      const res = await ipcRequest<{ message?: string }>('account_switch', {
        id: target.id,
        target: 'all',
        autoRefreshToken: true,
      });
      if (target.shouldQuitAndRelaunch) {
        await launchAntigravity().catch(() => {});
      }
      store.showToast(
        res.message || store.t('assistant_account.switched_to', { email: target.email }),
      );
      setPrompt(null);
      void store.refreshStatus(true);
      onSwitched?.();
    } catch (err) {
      if (target.shouldQuitAndRelaunch) {
        await launchAntigravity().catch(() => {});
      }
      store.showToast(
        store.t('assistant_account.switch_failed', { error: String(err) }),
        true,
      );
    } finally {
      setSwitching(false);
    }
  }, [onSwitched, prompt, store, switching]);

  const switchModal = prompt ? (
    <Modal
      title={store.t('assistant_account.switch_prompt_title', { display: prompt.display })}
      onClose={() => { if (!switching) setPrompt(null); }}
      footer={
        <>
          <button className="btn" disabled={switching} onClick={() => setPrompt(null)}>
            {store.t('common.cancel')}
          </button>
          <button className="btn btn-primary" disabled={switching} onClick={() => void confirmSwitch()}>
            {switching
              ? store.t('status.running_tasks')
              : prompt.hasRunningTask
                ? store.t('assistant_account.switch_busy_confirm')
                : store.t('assistant_account.switch_confirm')}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        {prompt.hasRunningTask
          ? store.t('assistant_account.switch_busy_body')
          : prompt.shouldQuitAndRelaunch
            ? store.t('assistant_account.switch_ready_body')
            : store.t('assistant_account.switch_stopped_body')}
      </div>
      {prompt.hasRunningTask && prompt.taskReason && (
        <div className="card-subtle" style={{ fontSize: 12, color: 'var(--amber)' }}>
          {prompt.taskReason}
        </div>
      )}
    </Modal>
  ) : null;

  return { requestSwitch, switchModal, switching };
}
