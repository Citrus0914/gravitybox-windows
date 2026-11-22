import { applicationChannel, savedApplicationChannel, applicationTarget, detectInstalledChannels, type ApplicationChannel, type ApplicationTarget } from './application-target.js';
import { UsageStatsManager } from './usage.js';
import {
  buildPricingCatalogPayloadSnapshot,
  readInstalledAppBundleVersion,
  readValidLiveIdeModelsSnapshot,
  type LiveIdeModelSnapshotEntry,
  type LiveIdeModelsSnapshot,
} from './pricing-catalog-runtime.js';
export {
  readInstalledAppBundleVersion,
  readValidLiveIdeModelsSnapshot,
  type LiveIdeModelSnapshotEntry,
  type LiveIdeModelsSnapshot,
};
import {
  projectAllUsagePeriodSummaries,
  projectUsagePeriodSummary,
} from './ipc-projections.js';
import { CacheMaintenance } from './maintenance.js';
import { mkdir, lstat, chmod, unlink, readFile, writeFile } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { isOwnedByCurrentUser, isWindows } from './platform/fs.js';
import {
  controlEndpointForStateDir,
  defaultStateDir,
  defaultTrashDir,
  isNamedPipeEndpoint,
} from './platform/paths.js';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bt, setActiveLocale, resolveInitialRuntimeLanguage, resolveLocale } from './i18n.js';
import { Controller, type AssistantStatus } from './controller.js';
import { atomicJson, readOptionalJson, sanitizeError } from './files.js';
import { discover } from './discovery.js';
import { Tasks } from './tasks.js';
import { acquireProcessLease, type ProcessLease } from './process-lock.js';
import { createHash } from 'node:crypto';
import { IdempotencyStore, canonicalPayload } from './ipc-idempotency.js';
export { canonicalPayload } from './ipc-idempotency.js';

const CONTROL_ENDPOINT_ENV_KEY = 'GRAVITYBOX_CONTROL_ENDPOINT';

function cliOption(argv: string[], name: string, fallback?: string) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
}

function sanitizeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return bt('common.action_incomplete');
  const msg = err.message || '';
  const redacted = sanitizeError(msg);
  const sanitized = redacted
    .replace(/\/(?:Users|private|var|tmp|Volumes)\/[^\s'"]+/g, bt('common.path_token'))
    .replace(/[A-Za-z]:\\Users\\[^\s'"]+/gi, bt('common.path_token'));
  return sanitized.slice(0, 200);
}

export type DashboardAggregateDeps = {
  getUsageSummary: () => Promise<any>;
  getPricingTable: () => Promise<any>;
};
export type DashboardAggregate = { usage: any; usageError: string };

export async function buildDashboardAggregate(deps: DashboardAggregateDeps): Promise<DashboardAggregate> {
  let usage: any = null;
  let usageError = '';
  try {
    const [summary, pricing] = await Promise.all([
      deps.getUsageSummary(),
      deps.getPricingTable(),
    ]);
    const allPeriodsProjected =
      Array.isArray(summary?.today?.by_model) && Array.isArray(summary?.today_hourly)
        ? projectAllUsagePeriodSummaries(summary)
        : undefined;
    const todayProjected = allPeriodsProjected?.today;
    usage = {
      todayTokens: summary.today.totals.total_tokens,
      totalTokens: summary.all_time.totals.total_tokens,
      estimatedUsd: summary.today.estimated_usd,
      allTimeEstimatedUsd: summary.all_time.estimated_usd,
      requestCount: summary.today.totals.request_count,
      totalRequestCount: summary.all_time.totals.request_count,
      pricingModels: Object.keys(pricing).length,
      todayPricedModels: summary.today.priced_models ?? 0,
      todayUnpricedModels: summary.today.unpriced_models ?? 0,
      unpricedModels: (summary as any).unpriced_models ?? 0,
      pricedModels: (summary as any).priced_models ?? 0,
      databasesScanned: (summary as any).databases_scanned ?? 0,
      databasesDiscovered: (summary as any).databases_discovered ?? 0,
      scanScopeDescription: (summary as any).scan_scope_description ?? '',
      hasError: (summary as any).has_error ?? false,
      failedDatabasesCount: (summary as any).failed_databases_count ?? 0,
      skippedLargeRecords: (summary as any).skipped_large_records ?? 0,
      availability: (summary as any).availability ?? 'complete',
      unknownTimeRecords: (summary as any).unknown_time_records ?? 0,
      unknownTimeTokens: (summary as any).unknown_time_tokens ?? 0,
      databaseDiagnostics: (summary as any).database_diagnostics ?? [],
      ...(todayProjected ? {
        todayHourly: todayProjected.todayHourly,
        todayByModel: todayProjected.byModel,
      } : {}),
      ...(allPeriodsProjected ? { periods: allPeriodsProjected } : {}),
    };
  } catch (error) {
    usageError = sanitizeErrorMessage(error);
  }
  return { usage, usageError };
}

export async function request(command: string): Promise<any> {
  const argv = process.argv.slice(2);
  const targetStateDir = resolve(cliOption(argv, '--state-dir', defaultStateDir())!);
  const targetSocketPath = process.env[CONTROL_ENDPOINT_ENV_KEY] || controlEndpointForStateDir(targetStateDir);
  if (!isNamedPipeEndpoint(targetSocketPath)) {
    const sockInfo = await lstat(targetSocketPath).catch((err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT') throw new Error(bt('main.assistant_not_running'));
      throw err;
    });
    if (!sockInfo.isSocket() || sockInfo.isSymbolicLink() || !isOwnedByCurrentUser(sockInfo)) {
      throw new Error(bt('main.socket_mismatch'));
    }
  }
  return new Promise((resolveReply, reject) => {
    const client = createConnection(targetSocketPath);
    let buffer = '';
    let received = 0;
    const decoder = new StringDecoder('utf8');
    client.setTimeout(['status', 'ping', 'task_list'].includes(command) ? 8000 : 120000, () => {
      client.destroy();
      reject(new Error(bt('main.request_timeout')));
    });
    client.on('connect', () => client.write(JSON.stringify({ command }) + '\n'));
    client.on('data', bytes => {
      received += bytes.length;
      if (received > 4_000_000) {
        client.destroy();
        reject(new Error(bt('main.response_too_large')));
        return;
      }
      buffer += decoder.write(bytes);
      if (buffer.includes('\n')) {
        client.end();
        try {
          resolveReply(JSON.parse(buffer.split('\n')[0]!));
        } catch {
          reject(new Error(bt('main.response_invalid_format')));
        }
      }
    });
    client.on('error', () => reject(new Error(bt('main.assistant_not_running'))));
  });
}

async function run() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback?: string) => cliOption(args, name, fallback);
  const command = option('--command');
  if (command) {
    console.log(JSON.stringify(await request(command)));
    return;
  }
  if (args.includes('--heal')) throw new Error(bt('main.heal_unsupported'));
  const stateDir = resolve(option('--state-dir', defaultStateDir())!);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stateInfo = await lstat(stateDir);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || !isOwnedByCurrentUser(stateInfo)) {
    throw new Error(bt('main.state_dir_mismatch'));
  }
  if (!isWindows) await chmod(stateDir, 0o700);
  const socketPath = process.env[CONTROL_ENDPOINT_ENV_KEY] || controlEndpointForStateDir(stateDir);

  let configuredChannel: unknown;
  let configuredHudEnabled: unknown;
  let configuredAppLanguage: unknown;
  let configuredAutoPricingSync: unknown;
  try {
    const parsedCfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
    configuredChannel = parsedCfg.applicationChannel;
    configuredHudEnabled = parsedCfg.hudEnabled;
    configuredAppLanguage = parsedCfg.appLanguage;
    configuredAutoPricingSync = parsedCfg.autoPricingSyncEnabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(bt('main.channel_config_unreadable'));
  }

  const explicitLocaleArg = option('--locale');
  const explicitSystemLocalesArg = option('--system-locales');
  const initialSystemLocales = explicitSystemLocalesArg
    ? explicitSystemLocalesArg.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const effectiveInitialSystemLocales = initialSystemLocales?.length ? initialSystemLocales : undefined;
  const explicitChannelArg = option('--channel');
  const explicitAppArg = option('--app');
  const explicitProfileArg = option('--profile');
  const requestedChannel = explicitChannelArg !== undefined ? applicationChannel(explicitChannelArg) : savedApplicationChannel(configuredChannel);
  const initialInstallInfo = detectInstalledChannels(requestedChannel);
  const channel: ApplicationChannel = (explicitChannelArg || explicitAppArg || explicitProfileArg)
    ? requestedChannel
    : initialInstallInfo.effectiveChannel;
  const selectedTarget = applicationTarget(channel);
  const appPath = explicitAppArg ?? selectedTarget.appPath;
  const profile = explicitProfileArg ?? selectedTarget.profile;
  const target: ApplicationTarget = applicationTarget(channel, undefined, { appPath, profile });

  if (args.includes('--diagnose')) {
    const endpoint = await discover(appPath, profile);
    console.log(JSON.stringify(endpoint ? { found: true, pid: endpoint.pid, appVersion: endpoint.appVersion, loopback: true } : { found: false }));
    return;
  }

  const geminiDir = option('--gemini-dir', process.env.GRAVITYBOX_GEMINI_DIR || process.env.GEMINI_DIR || join(homedir(), '.gemini'))!;
  const cacheMaintenance = new CacheMaintenance(profile, defaultTrashDir(), undefined, { stateDir, geminiDir, appPath });
  const liveIdeModelsPath = join(stateDir, 'live-ide-models.json');
  const usageManager = new UsageStatsManager({ stateDir, geminiDir });
  cacheMaintenance.setHooks({
    archiveDatabases: dbPaths => usageManager.archiveDatabasesBeforeClear(dbPaths),
    onMutated: () => usageManager.invalidateCache(),
  });

  const buildPricingCatalogPayload = () =>
    buildPricingCatalogPayloadSnapshot({
      appPath: target.appPath,
      liveIdeModelsPath,
      usageManager,
    });

  async function syncActiveOfficialModelsToUsageManager(): Promise<void> {
    try {
      await buildPricingCatalogPayload();
    } catch {}
  }

  const pricePrefs = await readOptionalJson<{ enabled?: boolean }>(join(stateDir, 'pricing-preferences.json'), 'pricing-preferences.json');
  if (pricePrefs) usageManager.setAutoRemotePricingSync(pricePrefs.enabled === true);
  else if (typeof configuredAutoPricingSync === 'boolean') usageManager.setAutoRemotePricingSync(configuredAutoPricingSync);

  const idempotencyStore = new IdempotencyStore();
  let backendLease: ProcessLease | undefined;
  backendLease = await acquireProcessLease(join(stateDir, 'backend.lock'), 0);
  const earlySignalExit = () => {
    backendLease?.releaseSync();
    process.exit(0);
  };
  process.once('exit', () => backendLease?.releaseSync());
  process.once('SIGTERM', earlySignalExit);
  process.once('SIGINT', earlySignalExit);

  try {
    if (configuredChannel === 'insiders') {
      const configPath = join(stateDir, 'config.json');
      const original = await readFile(configPath, 'utf8');
      const document = JSON.parse(original);
      if (document.applicationChannel === 'insiders') {
        await writeFile(join(stateDir, 'config-before-stable-only.json'), original, { mode: 0o600, flag: 'wx' })
          .catch(error => { if (error.code !== 'EEXIST') throw error; });
        await atomicJson(configPath, { ...document, applicationChannel: 'stable' });
      }
    }

    try {
      if (isNamedPipeEndpoint(socketPath)) {
        const live = await new Promise<boolean>((resolveLive, reject) => {
          const client = createConnection(socketPath);
          client.once('connect', () => { client.destroy(); resolveLive(true); });
          client.once('error', (error: NodeJS.ErrnoException) => {
            if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '')) resolveLive(false);
            else reject(new Error(bt('main.socket_unconfirmed')));
          });
          client.setTimeout(1500, () => { client.destroy(); reject(new Error(bt('main.socket_busy'))); });
        });
        if (live) throw new Error(bt('main.assistant_already_running'));
      } else {
        const info = await lstat(socketPath);
        if (!info.isSocket() || !isOwnedByCurrentUser(info)) throw new Error(bt('main.socket_mismatch'));
        const live = await new Promise<boolean>((resolveLive, reject) => {
          const client = createConnection(socketPath);
          client.once('connect', () => { client.destroy(); resolveLive(true); });
          client.once('error', (error: NodeJS.ErrnoException) => {
            if (['ECONNREFUSED', 'ENOENT'].includes(error.code ?? '')) resolveLive(false);
            else reject(new Error(bt('main.socket_unconfirmed')));
          });
          client.setTimeout(1500, () => { client.destroy(); reject(new Error(bt('main.socket_busy'))); });
        });
        if (live) throw new Error(bt('main.assistant_already_running'));
        const current = await lstat(socketPath);
        if (current.ino !== info.ino || current.dev !== info.dev) throw new Error(bt('main.socket_changed'));
        await unlink(socketPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const runtimePrefs = await readOptionalJson<{ language?: string; hudEnabled?: boolean }>(
      join(stateDir, 'runtime-preferences.json'),
      'runtime-preferences.json'
    );
    const preferredConfiguredLanguage =
      explicitLocaleArg ??
      (typeof configuredAppLanguage === 'string' && configuredAppLanguage.trim()
        ? configuredAppLanguage
        : typeof runtimePrefs?.language === 'string' && runtimePrefs.language.trim()
          ? runtimePrefs.language
          : effectiveInitialSystemLocales || process.env.GRAVITYBOX_SYSTEM_LOCALES
            ? 'system'
            : undefined);
    const initialLang = resolveInitialRuntimeLanguage({
      configuredLanguage: preferredConfiguredLanguage,
      systemLocales: effectiveInitialSystemLocales,
    });
    setActiveLocale(initialLang.resolvedLocale);

    let hudEnabled = typeof configuredHudEnabled === 'boolean' ? configuredHudEnabled : true;
    if (runtimePrefs && typeof configuredHudEnabled !== 'boolean' && typeof runtimePrefs.hudEnabled === 'boolean') {
      hudEnabled = runtimePrefs.hudEnabled;
    }

    let writeChain = Promise.resolve();
    let statusTasks: Tasks | undefined;
    let pendingStatus: any;
    let writingStatus = false;
    let lastStatusKey = '';
    let lastStatusWrite = 0;

    const onStatus = (status: AssistantStatus) => {
      const installState = detectInstalledChannels(channel);
      const snapshot = {
        ...status,
        applicationChannel: channel,
        applicationLabel: target.label,
        bothApplicationsInstalled: installState.bothInstalled,
        availableChannels: installState.channels,
        taskRevision: statusTasks?.revision ?? 0,
        runningTasks: statusTasks?.list().filter(t => t.state === 'running').length ?? 0,
      };
      const { updatedAt, rssMB, ...meaningful } = snapshot;
      const key = JSON.stringify(meaningful);
      if (key === lastStatusKey && Date.now() - lastStatusWrite < 30000) return;
      lastStatusKey = key;
      lastStatusWrite = Date.now();
      pendingStatus = snapshot;
      if (!writingStatus) {
        writingStatus = true;
        writeChain = writeChain.catch(() => {}).then(async () => {
          try {
            while (pendingStatus) {
              const currentSnapshot = pendingStatus;
              pendingStatus = undefined;
              await atomicJson(join(stateDir, 'status.json'), currentSnapshot, undefined, { durability: 'relaxed' });
            }
          } finally {
            writingStatus = false;
          }
        });
        writeChain.catch(() => {});
      }
    };

    let fixture: { port: number; origin: string } | undefined;
    if (option('--fixture-port')) {
      const port = Number(option('--fixture-port'));
      const origin = option('--fixture-origin');
      if (!Number.isInteger(port) || !origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
        throw new Error(bt('main.fixture_invalid'));
      }
      fixture = { port, origin };
    }

    const saveRuntimePreferences = async (patch: { language?: string; hudEnabled?: boolean }) => {
      const currentPrefs = (await readOptionalJson<Record<string, unknown>>(
        join(stateDir, 'runtime-preferences.json'),
        'runtime-preferences.json'
      )) ?? {};
      if (typeof patch.hudEnabled === 'boolean') hudEnabled = patch.hudEnabled;
      const nextPrefs = {
        ...currentPrefs,
        hudEnabled,
        ...(typeof patch.language === 'string' ? { language: patch.language } : {}),
      };
      const configPath = join(stateDir, 'config.json');
      try {
        const cfg = JSON.parse(await readFile(configPath, 'utf8'));
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg.schema === undefined || cfg.schema === 2)) {
          await atomicJson(configPath, {
            ...cfg,
            ...(typeof patch.hudEnabled === 'boolean' ? { hudEnabled } : {}),
            ...(typeof patch.language === 'string' ? { appLanguage: patch.language } : {}),
          });
        }
      } catch {}
      await atomicJson(join(stateDir, 'runtime-preferences.json'), nextPrefs);
    };

    const controller = new Controller({
      locale: initialLang.resolvedLocale,
      configuredLanguage: initialLang.configuredLanguage,
      hudEnabled,
      appPath,
      profile,
      fixture,
      geminiDir,
      stateDir,
      onStatus,
    });

    const tasks = new Tasks(stateDir, () => onStatus(controller.snapshot()));
    statusTasks = tasks;
    await tasks.start();

    let commandChain = Promise.resolve();
    let stopping = false;
    const ipcMetrics = { statusRequests: 0, taskPayloadReplies: 0 };

    const server = createServer(client => {
      client.setTimeout(10_000, () => client.destroy());
      let input = '';
      let received = 0;
      let handled = false;
      let parsed: any;
      let ownsIdempotency = false;
      const reply = (value: unknown) => {
        if (ownsIdempotency) {
          ownsIdempotency = false;
          idempotencyStore.complete(String(parsed.idempotencyKey), value);
        }
        if (client.destroyed) return;
        const withId = (parsed?.id !== undefined && typeof value === 'object' && value !== null)
          ? { id: parsed.id, ...(value as any), ...(parsed.requestId !== undefined ? { requestId: parsed.requestId } : {}) }
          : { ...(value as any), ...(parsed?.requestId !== undefined ? { requestId: parsed.requestId } : {}) };
        client.end(JSON.stringify(withId) + '\n');
      };
      client.on('error', () => {});
      const decoder = new StringDecoder('utf8');
      client.on('data', chunk => {
        if (handled) return;
        received += chunk.length;
        if (received > 4_000_000) {
          handled = true;
          reply({ ok: false, error: bt('main.request_too_large') });
          return;
        }
        input += decoder.write(chunk);
        if (!input.includes('\n')) return;
        handled = true;
        client.setTimeout(120_000, () => client.destroy());
        try {
          parsed = JSON.parse(input.split('\n')[0]!);
        } catch {
          reply({ ok: false, error: bt('main.request_invalid_format') });
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reply({ ok: false, error: bt('main.request_invalid_format') });
          return;
        }
        const command = parsed.command;
        if (stopping && command !== 'stop') {
          reply({ ok: false, error: bt('main.assistant_not_running') });
          return;
        }
        if (parsed.idempotencyKey) {
          if (typeof parsed.idempotencyKey !== 'string' || parsed.idempotencyKey.length > 256) {
            reply({ ok: false, error: bt('main.idempotency_invalid') });
            return;
          }
          const fingerprint = createHash('sha256').update(JSON.stringify(canonicalPayload(parsed))).digest('hex');
          const state = idempotencyStore.reserve(parsed.idempotencyKey, fingerprint, reply);
          if (state === 'waiting') return;
          if (state !== 'owner') {
            reply({ ok: false, error: state === 'conflict' ? bt('main.idempotency_conflict') : bt('main.too_many_requests') });
            return;
          }
          ownsIdempotency = true;
        }

        if (command === 'set_application_channel') {
          try {
            applicationChannel(parsed.channel);
            reply({
              ok: true,
              applicationChannel: 'stable',
              applicationLabel: target.label,
              bothApplicationsInstalled: false,
              availableChannels: detectInstalledChannels().channels,
            });
          } catch (error) {
            reply({ ok: false, error: sanitizeErrorMessage(error) });
          }
          return;
        }
        if (command === 'usage_cancel') {
          reply({ ok: true, cancelled: usageManager.cancelRead() });
          return;
        }
        if (command === 'ping') {
          reply({ ok: true, pid: process.pid });
          return;
        }
        if (command === 'status') {
          ipcMetrics.statusRequests++;
          const all = tasks.list();
          const revision = tasks.revision;
          const installState = detectInstalledChannels(channel);
          if (parsed.includeTasks !== false && parsed.tasksSince !== revision) ipcMetrics.taskPayloadReplies++;
          reply({
            ok: true,
            status: {
              ...controller.snapshot(),
              applicationChannel: channel,
              applicationLabel: target.label,
              bothApplicationsInstalled: installState.bothInstalled,
              availableChannels: installState.channels,
            },
            ipc: { ...ipcMetrics },
            taskRevision: revision,
            runningTasks: all.filter(t => t.state === 'running').length,
            ...(parsed.includeTasks === false || parsed.tasksSince === revision ? {} : { tasks: all }),
          });
          return;
        }
        if (command === 'task_list') {
          ipcMetrics.taskPayloadReplies++;
          reply({ ok: true, tasks: tasks.list() });
          return;
        }
        if (command === 'task_cancel') {
          const cancelled = tasks.cancel(parsed.id);
          reply(cancelled ? { ok: true } : { ok: false, error: bt('main.task_not_cancellable') });
          return;
        }
        if (command === 'stop') {
          tasks.cancel();
        }
        if (command === 'dashboard_summary') {
          (async () => {
            const pricingSyncPromise = syncActiveOfficialModelsToUsageManager();
            const aggregate = await buildDashboardAggregate({
              getUsageSummary: () => usageManager.getUsageSummary(),
              getPricingTable: async () => {
                await pricingSyncPromise;
                return usageManager.getActivePricingTable();
              },
            });
            reply({
              ok: true,
              usage: aggregate.usage,
              usageError: aggregate.usageError,
              generatedAt: new Date().toISOString(),
            });
          })().catch(error => reply({ ok: false, error: sanitizeErrorMessage(error) }));
          return;
        }

        if ([
          'maintenance_scan',
          'maintenance_history',
          'usage_snapshot_release',
          'usage_events',
          'usage_summary',
          'usage_breakdown',
          'usage_ledger_review',
          'api_pricing_get',
          'pricing_sync_status',
        ].includes(command)) {
          (async () => {
            if (command === 'pricing_sync_status') {
              await syncActiveOfficialModelsToUsageManager();
              reply({ ok: true, status: await usageManager.getPricingSyncStatus() });
              return;
            }
            if (command === 'usage_ledger_review') {
              reply({ ok: true, review: await usageManager.ledgerReview() });
              return;
            }
            if (command === 'maintenance_scan') {
              reply(await cacheMaintenance.scan({ retentionDays: parsed.retentionDays }));
              return;
            }
            if (command === 'maintenance_history') {
              reply({ ok: true, snapshots: await cacheMaintenance.history() });
              return;
            }
            if (command === 'usage_snapshot_release') {
              usageManager.releaseSnapshot(String(parsed.snapshotId ?? ''));
              reply({ ok: true });
              return;
            }
            if (command === 'usage_events') {
              const period = ['today', '7d', '30d', 'all'].includes(String(parsed.period)) ? String(parsed.period) : 'today';
              const dbFiles = Array.isArray(parsed.dbFiles)
                ? parsed.dbFiles.map((v: unknown) => String(v ?? '').trim()).filter(Boolean).slice(0, 64)
                : undefined;
              reply({
                ok: true,
                ...(await usageManager.getUsageEvents(
                  period,
                  String(parsed.query ?? ''),
                  Number(parsed.offset),
                  Number(parsed.limit),
                  typeof parsed.snapshotId === 'string' ? parsed.snapshotId : undefined,
                  parsed.pinSnapshot === true,
                  Boolean(parsed.force),
                  undefined,
                  dbFiles
                )),
              });
              return;
            }
            if (command === 'usage_summary') {
              const force = Boolean(parsed.force);
              const usage = await usageManager.getUsageSummary(force);
              reply(projectUsagePeriodSummary(usage, parsed.period, { includeAllPeriods: true }));
              return;
            }
            if (command === 'usage_breakdown') {
              const period = ['today', '7d', '30d', 'all'].includes(String(parsed.period))
                ? (String(parsed.period) as 'today' | '7d' | '30d' | 'all')
                : 'today';
              reply({
                ok: true,
                ...(await usageManager.getUsageBreakdown(period, {
                  force: Boolean(parsed.force),
                  projectId: typeof parsed.projectId === 'string' ? parsed.projectId : undefined,
                  snapshotId: typeof parsed.snapshotId === 'string' ? parsed.snapshotId : undefined,
                })),
              });
              return;
            }
            if (command === 'api_pricing_get') {
              const catalogPayload = await buildPricingCatalogPayload();
              reply({
                ok: true,
                ...catalogPayload,
                status: await usageManager.getPricingSyncStatus(),
              });
              return;
            }
          })().catch(error => reply({ ok: false, error: sanitizeErrorMessage(error) }));
          return;
        }

        commandChain = commandChain.catch(() => {}).then(async () => {
          try {
            if (stopping && command !== 'stop') {
              reply({ ok: false, error: bt('main.assistant_not_running') });
              return;
            }
            if (command === 'api_pricing_revalue_preview') {
              reply({ ok: true, preview: await usageManager.previewRevalueHistory(parsed.mode === 'unpriced_only' ? 'unpriced_only' : 'force_all') });
              return;
            }
            if (command === 'api_pricing_revalue') {
              const mode = parsed.mode === 'unpriced_only' ? 'unpriced_only' : 'force_all';
              reply({
                ok: true,
                ...(await usageManager.revalueHistory(parsed.confirm === true, {
                  mode,
                  previewId: typeof parsed.previewId === 'string' ? parsed.previewId : undefined,
                })),
              });
              return;
            }
            if (command === 'api_pricing_revalue_rollback') {
              reply({ ok: true, ...(await usageManager.restoreRevalueHistory(String(parsed.previewId ?? ''), parsed.confirm === true)) });
              return;
            }
            if (command === 'pricing_sync_set') {
              await atomicJson(join(stateDir, 'pricing-preferences.json'), { enabled: parsed.enabled === true });
              usageManager.setAutoRemotePricingSync(parsed.enabled === true);
              reply({ ok: true });
              return;
            }
            if (command === 'pricing_sync_check') {
              if (parsed.feedUrl !== undefined && typeof parsed.feedUrl !== 'string') {
                throw new Error(bt('main.pricing_feed_invalid'));
              }
              const res = await usageManager.syncRemotePricing(parsed.feedUrl, true);
              const catalogPayload = await buildPricingCatalogPayload();
              reply({ ok: true, ...res, ...catalogPayload, status: await usageManager.getPricingSyncStatus() });
              return;
            }
            if (command === 'hud_set') {
              const nextHud = parsed.enabled !== false;
              await saveRuntimePreferences({ hudEnabled: nextHud });
              await controller.configureHud(nextHud);
              await writeChain;
              reply({ ok: true, status: controller.snapshot() });
              return;
            }
            if (command === 'maintenance_smart_clear') {
              reply(await cacheMaintenance.smartClear({
                scopes: parsed.scopes,
                retentionDays: parsed.retentionDays,
                keepLocalSnapshots: parsed.keepLocalSnapshots,
              }));
              return;
            }
            if (command === 'maintenance_clear') {
              reply(await cacheMaintenance.clear(parsed.token, parsed.selectedNames));
              return;
            }
            if (command === 'maintenance_restore') {
              reply(await cacheMaintenance.restore(parsed.snapshotId ?? parsed.id));
              return;
            }
            if (command === 'maintenance_preflight') {
              if (tasks.list().some(t => t.state === 'running')) throw new Error(bt('main.preflight_task_running'));
              if (await cacheMaintenance.hasRunningConversation()) throw new Error(bt('main.preflight_agent_running'));
              reply(await controller.maintenancePreflight());
              return;
            }
            if (command === 'language_set') {
              const requested = typeof parsed.language === 'string' && parsed.language.trim() ? parsed.language.trim() : 'system';
              const systemLocales = Array.isArray(parsed.systemLocales)
                ? parsed.systemLocales.filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
                : undefined;
              const resolved = resolveLocale(requested, systemLocales?.length ? systemLocales : undefined);
              setActiveLocale(resolved);
              usageManager.invalidateCache();
              await saveRuntimePreferences({ language: requested });
              await controller.setLocale(resolved, requested);
            } else if (command === 'stop') {
              stopping = true;
              server.close();
              await tasks.stop();
              await controller.stop();
            } else {
              throw new Error(bt('main.unknown_command'));
            }
            await writeChain;
            reply({ ok: true, status: controller.snapshot() });
            if (stopping) {
              if (!isNamedPipeEndpoint(socketPath)) await unlink(socketPath).catch(() => {});
              await backendLease?.release();
              setTimeout(() => process.exit(0), 100);
            }
          } catch (error) {
            reply({ ok: false, error: sanitizeErrorMessage(error) });
          }
        });
      });
    });

    server.maxConnections = 64;
    if (isNamedPipeEndpoint(socketPath)) {
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolveListen);
      });
    } else {
      const previousUmask = process.umask(0o177);
      try {
        await new Promise<void>((resolveListen, reject) => {
          server.once('error', reject);
          server.listen(socketPath, resolveListen);
        });
      } finally {
        process.umask(previousUmask);
      }
      await chmod(socketPath, 0o600);
    }

    const stop = async (code = 0) => {
      if (stopping) return;
      stopping = true;
      server.close();
      await commandChain.catch(() => {});
      await tasks.stop();
      await controller.stop();
      await writeChain;
      if (!isNamedPipeEndpoint(socketPath)) await unlink(socketPath).catch(() => {});
      await backendLease?.release();
      process.exit(code);
    };
    process.off('SIGTERM', earlySignalExit);
    process.off('SIGINT', earlySignalExit);
    process.on('SIGTERM', () => void stop());
    process.on('SIGINT', () => void stop());
    process.on('uncaughtException', error => {
      console.error(`[GravityBox] ${sanitizeError(error?.stack ?? error?.message ?? bt('main.uncaught_exception'))}`);
      if (stopping) void stop(1);
    });
    process.on('unhandledRejection', reason => {
      console.error(`[GravityBox] ${reason instanceof Error ? sanitizeError(reason.message) : bt('main.unhandled_rejection')}`);
    });

    onStatus(controller.snapshot());
    void usageManager.getUsageSummary(false).catch(() => {});
    await controller.start();
  } catch (error) {
    await backendLease?.release().catch(() => {});
    throw error;
  }
}

function normalizeEntryPath(pathValue: string): string {
  let normalized = pathValue;
  if (isWindows) {
    if (normalized.startsWith('\\\\?\\UNC\\')) normalized = '\\\\' + normalized.slice(8);
    else if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
    normalized = resolve(normalized).toLowerCase();
  } else {
    normalized = resolve(normalized);
  }
  return normalized;
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  if (normalizeEntryPath(entry) === normalizeEntryPath(modulePath)) return true;
  try {
    return normalizeEntryPath(realpathSync(entry)) === normalizeEntryPath(realpathSync(modulePath));
  } catch {
    return false;
  }
}

if (process.env.GRAVITYBOX_IMPORT_ONLY !== '1' && isDirectEntry()) {
  run().catch(error => {
    console.error(`[GravityBox] ${sanitizeError((error as Error)?.message ?? bt('main.startup_failed'))}`);
    process.exitCode = 1;
  });
}
