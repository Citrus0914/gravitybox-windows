import { CdpHudBridge, HUD_BRIDGE_BINDING_NAME } from './hud.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CDP, assertLoopback } from './cdp.js';
import { allowedTarget, discover, verifyPageService, type Endpoint } from './discovery.js';
import { normalizeLocale, translate } from './i18n.js';
import { watch, type FSWatcher } from 'node:fs';

export type AssistantStatus = {
  schema: 1;
  mode: string;
  message: string;
  appVersion?: string;
  windows: number;
  errors: string[];
  rssMB: number;
  updatedAt: string;
  pid: number;
  hudEnabled: boolean;
  locale: string;
  configuredLanguage: string;
  taskRevision?: number;
};

type PageSession = {
  cdp: CDP;
  targetId: string;
  contextId?: number;
  registration?: string;
  updateChain: Promise<void>;
  url: string;
  detaching?: boolean;
};

const WORLD = 'GRAVITYBOX-localization-v1';

export class Controller {
  private endpoint?: Endpoint;
  private browser?: CDP;
  private pages = new Map<string, PageSession>();
  private reconnection?: NodeJS.Timeout;
  private targetTimer?: NodeJS.Timeout;
  private stopped = false;
  private locale = 'zh-Hans';
  private configuredLanguage = 'zh-Hans';
  private hudEnabled = true;
  private reconnectionDelay = 1000;
  private syncing = false;
  private syncAgain = false;
  private engine = '';
  private runtimeId = '';
  private bootCache = new Map<string, string>();
  private controlChain: Promise<void> = Promise.resolve();
  private profileWatchers: FSWatcher[] = [];
  private connecting?: Promise<void>;
  private syncWaiters: (() => void)[] = [];
  private unverifiedWindowRetries = 0;
  private hudBridge: CdpHudBridge;
  status: AssistantStatus;

  constructor(private options: {
    appPath: string;
    profile: string;
    fixture?: { port: number; origin: string };
    stateDir?: string;
    geminiDir?: string;
    hudEnabled?: boolean;
    locale?: string;
    configuredLanguage?: string;
    onStatus: (status: AssistantStatus) => void;
  }) {
    const initialLocale = normalizeLocale(options.locale ?? '') ?? 'zh-Hans';
    this.locale = initialLocale;
    this.configuredLanguage = options.configuredLanguage ?? initialLocale;
    this.hudEnabled = options.hudEnabled !== false;
    this.hudBridge = new CdpHudBridge({
      geminiDir: options.geminiDir || process.env.GRAVITYBOX_GEMINI_DIR || process.env.GEMINI_DIR,
      stateDir: options.stateDir,
    });
    this.status = {
      schema: 1,
      mode: 'starting',
      message: this.t('status.starting'),
      windows: 0,
      errors: [],
      rssMB: 0,
      updatedAt: '',
      pid: process.pid,
      hudEnabled: this.hudEnabled,
      locale: this.locale,
      configuredLanguage: this.configuredLanguage,
    };
  }

  private get dormant() {
    return !this.hudEnabled;
  }

  private t(key: string, params?: Record<string, string | number | boolean | null | undefined>, fallback?: string): string {
    return translate(this.locale, key, params, { namespace: 'backend', fallback });
  }

  private enqueueControl<T>(task: () => Promise<T>): Promise<T> {
    const run = this.controlChain.catch(() => {}).then(task);
    this.controlChain = run.then(() => {}, () => {});
    return run;
  }

  private publish(mode?: string, message?: string) {
    if (mode) this.status.mode = mode;
    if (message) this.status.message = message;
    this.status.hudEnabled = this.hudEnabled;
    this.status.locale = this.locale;
    this.status.configuredLanguage = this.configuredLanguage;
    this.status.windows = this.pages.size;
    this.status.rssMB = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
    this.status.updatedAt = new Date().toISOString();
    this.options.onStatus({ ...this.status });
  }

  private activeAppPath(): string {
    return this.endpoint?.appPath ?? this.options.appPath;
  }

  private closeProfileWatchers() {
    for (const w of this.profileWatchers.splice(0)) {
      try { w.close(); } catch {}
    }
  }

  private watchProfiles() {
    this.closeProfileWatchers();
    if (this.options.fixture) return;
    for (const profileDir of [this.options.profile]) {
      try {
        const watcher = watch(profileDir, (_event, name) => {
          if (String(name) === 'DevToolsActivePort' && !this.stopped && !this.dormant) {
            clearTimeout(this.reconnection);
            this.reconnectionDelay = 1000;
            this.unverifiedWindowRetries = 0;
            void this.tryConnect().catch(() => this.retry());
          }
        });
        watcher.on('error', () => { try { watcher.close(); } catch {} });
        this.profileWatchers.push(watcher);
      } catch {
        // Missing profile uses bounded discovery retries.
      }
    }
  }

  async start() {
    this.engine = await readFile(new URL('./engine.js', import.meta.url), 'utf8');
    this.runtimeId = createHash('sha256').update(this.engine).digest('hex');
    this.watchProfiles();
    if (this.dormant) {
      if (!this.options.fixture) {
        this.endpoint = await discover(this.options.appPath, this.options.profile);
        this.status.appVersion = this.endpoint?.appVersion;
      }
      this.publish('paused', this.t('status.paused'));
      return;
    }
    await this.tryConnect();
  }

  private tryConnect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const attempt = this.connectOnce();
    this.connecting = attempt;
    return attempt.finally(() => {
      this.connecting = undefined;
    });
  }

  private async connectOnce() {
    if (this.stopped || this.dormant) return;
    try {
      if (this.browser) {
        await this.sync();
        return;
      }
      if (this.options.fixture) {
        const port = this.options.fixture.port;
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
        const version = await response.json() as { webSocketDebuggerUrl: string };
        const url = assertLoopback(version.webSocketDebuggerUrl);
        if (Number(url.port) !== port) throw new Error(this.t('controller.err.fixture_port_mismatch'));
        this.endpoint = { port, browserURL: url.href, pid: 0, appVersion: 'fixture', legacyPatch: false };
      } else {
        this.endpoint = await discover(this.options.appPath, this.options.profile);
      }
      if (this.stopped || this.dormant) return;
      if (!this.endpoint) {
        this.publish('waiting', this.t('status.waiting_app'));
        this.retry();
        return;
      }
      this.status.appVersion = this.endpoint.appVersion;

      if (!this.options.fixture) {
        const activeApp = this.activeAppPath();
        const targets = await (await fetch(`http://127.0.0.1:${this.endpoint.port}/json/list`, {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        })).json() as { type: string; url: string }[];
        const target = targets.find(t => allowedTarget(t));
        if (!target || !(await verifyPageService(target.url, activeApp))) {
          this.publish('waiting-window', this.t('status.waiting_window'));
          this.retry();
          return;
        }
      }

      const browser = (this.browser = new CDP(this.endpoint.browserURL));
      await browser.connect();
      if (this.stopped || this.dormant) {
        browser.close();
        this.browser = undefined;
        return;
      }
      browser.on('Target.targetCreated', () => this.scheduleSync());
      browser.on('Target.targetInfoChanged', () => this.scheduleSync());
      browser.on('Target.targetDestroyed', () => this.scheduleSync());
      browser.on('disconnected', () => {
        void this.disconnectPages();
        this.browser = undefined;
        if (!this.stopped && !this.dormant) {
          this.reconnectionDelay = 1000;
          this.unverifiedWindowRetries = 0;
          this.publish('waiting', this.t('status.reconnecting'));
          this.retry();
        }
      });
      await browser.send('Target.setDiscoverTargets', { discover: true });
      this.reconnectionDelay = 1000;
      this.unverifiedWindowRetries = 0;
      await this.sync();
    } catch (error) {
      this.browser?.close();
      this.browser = undefined;
      this.publish('error', (error as Error).message);
      this.retry();
    }
  }

  private retry(delay?: number) {
    clearTimeout(this.reconnection);
    if (this.stopped || this.dormant) return;
    const wait = delay ?? this.reconnectionDelay;
    this.reconnection = setTimeout(() => {
      void this.tryConnect();
    }, wait);
    if (delay === undefined) this.reconnectionDelay = Math.min(30000, this.reconnectionDelay * 2);
  }

  private scheduleSync(delayMs = 100) {
    if (this.stopped || this.dormant) return;
    clearTimeout(this.targetTimer);
    this.targetTimer = setTimeout(
      () => void this.sync().catch(() => this.publish('error', this.t('status.probe_failed'))),
      delayMs
    );
  }

  private boot(url: string) {
    const page = new URL(url);
    const key = `${page.origin}${page.pathname}:${this.hudEnabled}:${this.locale}`;
    const cached = this.bootCache.get(key);
    if (cached) return cached;
    const bootPayload = {
      origin: page.origin,
      path: page.pathname,
      runtimeId: this.runtimeId,
      hudEnabled: this.hudEnabled,
      locale: this.locale,
      languageMode: this.locale === 'en' ? 'en' : 'zh',
    };
    const source = `delete globalThis.__GRAVITYBOX_ATTACH_HUD__;globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify(bootPayload)};\n${this.engine}`;
    if (this.bootCache.size < 4) this.bootCache.set(key, source);
    return source;
  }

  async sync() {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    if (!this.endpoint || !this.browser || this.stopped) return;
    this.syncing = true;
    try {
      const response = await fetch(`http://127.0.0.1:${this.endpoint.port}/json/list`, {
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      const targets = await response.json() as { id: string; type: string; url: string; webSocketDebuggerUrl: string }[];
      const permitted = targets.filter(target => allowedTarget(target, this.options.fixture?.origin));

      for (const [id, session] of this.pages) {
        const target = permitted.find(t => t.id === id);
        if (!target || this.dormant) {
          await this.detach(session);
          this.pages.delete(id);
        } else if (target.url !== session.url || (session.contextId === undefined && !session.detaching)) {
          try {
            if (target.url !== session.url) {
              session.url = target.url;
              await this.refreshRegistration(session);
            }
            await this.queueBootstrap(session, false);
          } catch {
            await this.detach(session);
            this.pages.delete(id);
          }
        }
      }

      this.status.errors = [];
      if (!this.dormant) {
        for (const target of permitted) {
          if (this.pages.has(target.id)) continue;
          if (this.dormant || this.stopped) break;
          try {
            if (!this.options.fixture && !(await verifyPageService(target.url, this.activeAppPath()))) {
              this.status.errors.push(this.t('controller.err.window_unverified'));
              continue;
            }
            if (this.dormant || this.stopped) break;
            const socketURL = assertLoopback(target.webSocketDebuggerUrl);
            if (Number(socketURL.port) !== this.endpoint.port) {
              throw new Error(this.t('controller.err.window_port_mismatch'));
            }
            const cdp = new CDP(socketURL.href);
            const session: PageSession = { cdp, targetId: target.id, url: target.url, updateChain: Promise.resolve() };
            await cdp.connect();
            if (this.dormant || this.stopped) {
              cdp.close();
              break;
            }
            this.pages.set(target.id, session);
            cdp.on('disconnected', () => {
              this.hudBridge.detachTarget(target.id);
              if (!session.detaching && this.pages.get(target.id) === session) {
                this.pages.delete(target.id);
                this.scheduleSync();
              }
            });
            cdp.on('Page.frameNavigated', (event) => {
              if (!event.frame?.parentId) {
                this.hudBridge.detachTargetPanes(target.id);
                session.contextId = undefined;
                void this.queueBootstrap(session).catch(() => this.scheduleSync(1500));
              }
            });
            cdp.on('Page.navigatedWithinDocument', () => this.scheduleSync());
            cdp.on('Runtime.executionContextsCleared', () => {
              this.hudBridge.detachTargetPanes(target.id);
              session.contextId = undefined;
              if (!session.detaching && !this.dormant && !this.stopped) this.scheduleSync(300);
            });
            await cdp.send('Page.enable');
            await cdp.send('Runtime.enable');
            await this.hudBridge.attachToTarget(target.id, cdp, () => session.contextId, WORLD);
            cdp.on('Runtime.bindingCalled', (event) => {
              if (event.name === HUD_BRIDGE_BINDING_NAME && this.hudEnabled && event.executionContextId === session.contextId) {
                this.hudBridge.handleRawBindingPayload(target.id, event.payload);
              }
            });
            await this.refreshRegistration(session);
            await this.queueBootstrap(session, false);
          } catch (error) {
            const failed = this.pages.get(target.id);
            if (failed) {
              await this.detach(failed);
              this.pages.delete(target.id);
            }
            this.status.errors.push(
              (error as Error).message === this.t('controller.err.unrecognized_structure')
                ? (error as Error).message
                : this.t('controller.err.window_inject_failed')
            );
          }
        }
      }

      const hasUnreadyPage = [...this.pages.values()].some(session => !session.detaching && session.contextId === undefined);
      if (!this.dormant && !this.stopped && permitted.length > 0 && (this.pages.size < permitted.length || hasUnreadyPage)) {
        if (this.unverifiedWindowRetries < 20) {
          this.unverifiedWindowRetries++;
          this.scheduleSync(1500);
        }
      } else {
        this.unverifiedWindowRetries = 0;
      }

      const defaultMode = this.dormant
        ? 'paused'
        : this.pages.size
          ? 'connected'
          : 'waiting-window';
      const defaultMsg = this.dormant
        ? this.t('status.paused')
        : this.pages.size
          ? this.t('status.connected')
          : this.t('status.waiting_supported_window');
      this.publish(defaultMode, defaultMsg);
    } finally {
      this.syncing = false;
      for (const resolve of this.syncWaiters.splice(0)) resolve();
      if (this.syncAgain) {
        this.syncAgain = false;
        this.scheduleSync();
      }
    }
  }

  private queueBootstrap(session: PageSession, reportUnhandledError = true): Promise<void> {
    if (session.detaching) return Promise.resolve();
    session.updateChain = session.updateChain.catch(() => {}).then(async () => {
      if (this.dormant || this.stopped || session.detaching || this.pages.get(session.targetId) !== session) return;
      const tree = await session.cdp.send('Page.getFrameTree');
      const frame = tree.frameTree.frame;
      if (!allowedTarget({ type: 'page', url: frame.url }, this.options.fixture?.origin)) return;
      if (!this.options.fixture && this.endpoint) {
        if (!(await verifyPageService(frame.url, this.activeAppPath()))) {
          throw new Error(this.t('controller.err.page_unverified'));
        }
      }

      session.url = frame.url;
      let previous: any;
      if (session.contextId !== undefined) {
        try {
          previous = await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()', session.contextId);
        } catch {
          session.contextId = undefined;
        }
      }
      if (session.contextId === undefined || !previous?.active) {
        const context = await session.cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
        session.contextId = context.executionContextId;
      }
      if (/^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i.test(new URL(frame.url).pathname)) {
        throw new Error(this.t('controller.err.onboarding_skipped'));
      }
      if (this.dormant || this.stopped || session.detaching) return;

      if (!previous?.active || previous.runtimeId !== this.runtimeId) {
        if (previous?.active) {
          await session.cdp.evaluate(
            this.hudEnabled
              ? 'globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.({keepHud:true})'
              : '(globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose?.())',
            session.contextId
          );
        }
        await session.cdp.evaluate(this.boot(session.url), session.contextId);
      }

      if (this.hudEnabled) {
        await session.cdp.evaluate(
          `(globalThis.__GRAVITYBOX_ATTACH_HUD__?.(), globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(this.locale)}), globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true), globalThis.__GRAVITYBOX_HUD_V1__?.syncAllSessions?.())`,
          session.contextId
        ).catch(() => {});
      } else {
        await session.cdp.evaluate('globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(false)', session.contextId).catch(() => {});
      }
    });
    if (reportUnhandledError) {
      session.updateChain.catch(() => {
        if (!this.status.errors.includes(this.t('controller.err.window_connect_failed'))) {
          this.status.errors.push(this.t('controller.err.window_connect_failed'));
        }
        this.publish();
      });
    }
    return session.updateChain;
  }

  private refreshRegistration(session: PageSession): Promise<void> {
    if (session.detaching) return Promise.resolve();
    session.updateChain = session.updateChain.catch(() => {}).then(async () => {
      if (session.detaching || this.dormant || this.stopped) return;
      if (session.registration) {
        await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.registration });
        session.registration = undefined;
      }
      if (session.detaching || this.dormant || this.stopped) return;
      const registered = await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: this.boot(session.url),
        worldName: WORLD,
      });
      if (session.detaching || this.dormant || this.stopped) {
        await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: registered.identifier });
        return;
      }
      session.registration = registered.identifier;
    });
    return session.updateChain;
  }

  private async detach(session: PageSession) {
    session.detaching = true;
    this.hudBridge.detachTarget(session.targetId);
    let restorationFailed = false;
    try {
      await session.updateChain.catch(() => {});
      if (session.registration) {
        await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.registration });
      }
      let ctxId = session.contextId;
      if (ctxId === undefined) {
        const tree = await session.cdp.send('Page.getFrameTree');
        const world = await session.cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD });
        ctxId = world.executionContextId;
      }
      await session.cdp.evaluate(
        '(globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose())',
        ctxId
      );
    } catch {
      restorationFailed = true;
    }
    session.cdp.close();
    if (restorationFailed) this.status.errors.push(this.t('controller.err.window_lost_restore'));
  }

  private async disconnectPages() {
    for (const session of this.pages.values()) await this.detach(session);
    this.pages.clear();
  }

  private async quiescePages() {
    await this.connecting?.catch(() => {});
    if (this.syncing) await new Promise<void>(resolve => this.syncWaiters.push(resolve));
    await this.disconnectPages();
  }

  private async quiesce() {
    await this.controlChain.catch(() => {});
    await this.quiescePages();
  }

  setLocale(nextLocale: string, configuredLanguage?: string): Promise<void> {
    return this.enqueueControl(async () => {
      const resolved = normalizeLocale(nextLocale) ?? 'en';
      this.locale = resolved;
      if (configuredLanguage !== undefined) {
        this.configuredLanguage = configuredLanguage;
      }
      this.status.errors = [];
      this.bootCache.clear();
      await Promise.allSettled(
        [...this.pages.values()].map(async session => {
          await this.refreshRegistration(session);
          if (session.contextId !== undefined && !session.detaching) {
            await session.cdp.evaluate(
              `globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(this.locale)})`,
              session.contextId
            );
          }
        })
      );
      if (this.hudEnabled) {
        await this.hudBridge.refreshAllForLocaleChange();
      }
      const mode = this.dormant ? 'paused' : this.pages.size ? 'connected' : 'waiting-window';
      const msg = this.dormant
        ? this.t('status.paused')
        : this.pages.size
          ? this.t('status.connected')
          : this.t('status.waiting_supported_window');
      this.publish(mode, msg);
    });
  }

  configureHud(enabled: boolean): Promise<void> {
    return this.enqueueControl(async () => {
      this.hudEnabled = enabled;
      this.options.hudEnabled = enabled;
      this.bootCache.clear();
      if (!enabled) {
        clearTimeout(this.reconnection);
        clearTimeout(this.targetTimer);
        this.hudBridge.clearActivePanes();
        await this.disconnectPages();
        this.browser?.close();
        this.browser = undefined;
        this.publish('paused', this.t('status.paused'));
        return;
      }
      this.reconnectionDelay = 1000;
      this.unverifiedWindowRetries = 0;
      if (this.browser) {
        await this.sync();
      } else {
        await this.tryConnect();
      }
    });
  }

  snapshot(): AssistantStatus {
    this.status.rssMB = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
    this.status.updatedAt = new Date().toISOString();
    return { ...this.status, errors: [...this.status.errors] };
  }

  async hasRunningAgentTask(): Promise<{ busy: boolean; reason?: string }> {
    for (const page of this.pages.values()) {
      if (page.contextId === undefined) continue;
      try {
        const res = await Promise.race([
          page.cdp.evaluate(
            `(() => {
              const engineState = globalThis.__GRAVITYBOX_ENGINE_V1__?.draftState?.();
              if (engineState?.generating) return { busy: true, reason: ${JSON.stringify(this.t('controller.task.streaming_busy'))} };
              const rendered = e => !!e?.getClientRects?.().length && getComputedStyle(e).visibility !== 'hidden';
              const stopBtn = [...document.querySelectorAll('button,[role="button"],[data-testid*="stop"],[data-testid*="cancel"]')].some(e => {
                if (!rendered(e)) return false;
                const label = (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('data-tooltip-id') || e.textContent || '').trim();
                if (/^(Stop generating|Stop|Cancel generation|Cancel|Abort|Interrupt|停止生成|停止|取消生成|终止生成|中断)$/i.test(label)) return true;
                if (/(?:stop|cancel)\s*(?:generation|generating|streaming|agent|response|task)/i.test(label)) return true;
                if (e.querySelector?.('.codicon-debug-stop, .codicon-stop-circle')) return true;
                return false;
              });
              if (stopBtn) return { busy: true, reason: ${JSON.stringify(this.t('controller.task.agent_busy'))} };
              const streaming = [...document.querySelectorAll('[data-state="streaming"],[data-streaming="true"],.codicon-loading')].some(rendered);
              if (streaming) return { busy: true, reason: ${JSON.stringify(this.t('controller.task.agent_busy'))} };
              return { busy: false };
            })()`,
            page.contextId
          ),
          new Promise<{ busy: boolean }>(resolve => setTimeout(() => resolve({ busy: false }), 600)),
        ]);
        if (res?.busy) return res;
      } catch {}
    }
    return { busy: false };
  }

  async maintenancePreflight() {
    if (!this.endpoint || !this.pages.size) return { ok: true, pid: 0 };
    const endpoint = await discover(this.options.appPath, this.options.profile);
    if (!endpoint || endpoint.pid !== this.endpoint.pid) return { ok: true, pid: endpoint?.pid ?? 0 };
    const agentTask = await this.hasRunningAgentTask();
    if (agentTask.busy) {
      throw new Error(
        agentTask.reason
          ? this.t('controller.preflight.reason_wait', { reason: agentTask.reason })
          : this.t('controller.preflight.task_wait')
      );
    }
    for (const page of this.pages.values()) {
      if (page.contextId === undefined) continue;
      const state = await page.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.maintenanceState?.()', page.contextId);
      if (state?.busy) throw new Error(this.t('controller.preflight.save_drafts'));
    }
    return { ok: true, pid: endpoint.pid };
  }

  async stop() {
    this.stopped = true;
    this.closeProfileWatchers();
    clearTimeout(this.reconnection);
    clearTimeout(this.targetTimer);
    this.hudBridge.dispose();
    await this.quiesce();
    this.browser?.close();
    this.publish('stopped', this.status.errors.length ? this.t('status.stopped_with_errors') : this.t('status.stopped'));
  }
}
