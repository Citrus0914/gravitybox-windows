/* Lightweight HUD-only runtime bootstrap for GravityBox Lite. Runs in an isolated CDP world; no application code is patched. */
(function bootstrapRuntime() {
  'use strict';
  const options = globalThis.__GRAVITYBOX_BOOT__;
  if (!options || location.origin !== options.origin) return;
  if (options.path === '/fixture' && location.pathname !== '/fixture') return;
  const allowedPath =
    location.pathname === '/' ||
    /^\/(?:history|sidecars|customizations|automations|settings|settings-standalone|terminal-standalone|new-project|multi|artifact|s|chatski-connect)(?:\/.*)?$/i.test(location.pathname) ||
    /^\/c(?:\/|\/(?:[0-9a-f-]{36}|_new)(?:\/.*)?)?$/i.test(location.pathname) ||
    /^\/(?:forked|view|battle)\/.*$/i.test(location.pathname) ||
    (options.path === '/fixture' && location.pathname === '/fixture');
  if (!allowedPath) return;
  if (/^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i.test(location.pathname)) return;

  const KEY = '__GRAVITYBOX_ENGINE_V1__';
  if (globalThis[KEY]) {
    globalThis.__GRAVITYBOX_ATTACH_HUD__?.();
    return;
  }

  const draftState = () => {
    const rendered = (e) => !!e?.getClientRects?.().length && getComputedStyle(e).visibility !== 'hidden';
    const draft = [...document.querySelectorAll('input,textarea,[contenteditable]:not([contenteditable="false"])')].some(
      (e) =>
        rendered(e) &&
        !e.readOnly &&
        !e.disabled &&
        !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'hidden', 'file'].includes(e.type) &&
        (e.value ?? e.textContent ?? '').trim()
    );
    const attachments =
      [...document.querySelectorAll('input[type="file"]')].some((e) => e.files?.length > 0) ||
      [...document.querySelectorAll('[data-testid*="attachment"],[data-testid*="file-chip"]')].some(rendered);
    const unsaved = [...document.querySelectorAll('.tab.dirty,[data-dirty="true"],[role="tab"][aria-label*="unsaved" i]')].some(rendered);
    const generating = [...document.querySelectorAll('button,[role="button"]')].some(
      (e) => rendered(e) && /^(Stop generating|Stop|停止生成|停止)$/.test(e.getAttribute('aria-label') || e.textContent.trim())
    );
    return { busy: draft || attachments || unsaved || generating, draft, attachments, unsaved, generating };
  };

  const maintenanceState = () => {
    const state = draftState();
    const hasPopup = [...document.querySelectorAll('[role="dialog"],[role="menu"]')].some(
      (e) => !!e?.getClientRects?.().length && getComputedStyle(e).visibility !== 'hidden'
    );
    return { ...state, busy: state.busy || hasPopup };
  };

  globalThis[KEY] = {
    state: () => ({
      active: true,
      runtimeId: options.runtimeId,
      languageMode: options.locale === 'en' ? 'en' : 'zh',
    }),
    getLanguageMode: () => (options.locale === 'en' ? 'en' : 'zh'),
    draftState,
    maintenanceState,
    dispose(opts) {
      if (!opts?.keepHud) {
        try {
          globalThis.__GRAVITYBOX_HUD_V1__?.dispose?.();
        } catch {}
      }
      delete globalThis[KEY];
      if (globalThis.__GRAVITYBOX_BOOT__ === options) delete globalThis.__GRAVITYBOX_BOOT__;
      return { restored: 0, skipped: 0, active: false };
    },
  };

  globalThis.__GRAVITYBOX_ATTACH_HUD__?.();
})();
