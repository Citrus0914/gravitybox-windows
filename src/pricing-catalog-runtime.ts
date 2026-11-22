import { lstat, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readOptionalJson } from './files.js';
import { isOwnedByCurrentUser, isWindows } from './platform/fs.js';
import { bundleLayoutPaths } from './platform/paths.js';
import { winExeInfo } from './platform/win-helper.js';
import type { UsageStatsManager } from './usage.js';
import {
  normalizeCatalogTierLabel,
  resolvePricingCatalogSnapshot,
  type PricingCatalogSnapshotResult,
  type PricingCatalogSourceInput,
} from './pricing.js';

const execFileAsync = promisify(execFile);
const MAX_LIVE_IDE_SNAPSHOT_MODELS = 256;

export interface LiveIdeModelSnapshotEntry {
  id: string;
  displayName: string | null;
  modelOrAlias: string | null;
  disabled: boolean;
}

export interface LiveIdeModelsSnapshot {
  schema: 1;
  appVersion: string;
  tier: string;
  observedAt: number;
  models: LiveIdeModelSnapshotEntry[];
}

export async function readInstalledAppBundleVersion(appPath: string): Promise<string> {
  if (!appPath) return '';
  if (isWindows && !appPath.endsWith('.app')) {
    const layout = bundleLayoutPaths(appPath, 'Antigravity');
    try {
      const info = await winExeInfo(layout.executablePath);
      if (info.fileVersion.trim()) return info.fileVersion.trim();
    } catch {}
    try {
      const pkg = JSON.parse(await readFile(layout.unpackedPackageJsonPath, 'utf8'));
      if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim();
    } catch {}
    return '';
  }
  const plistPath = join(appPath, 'Contents/Info.plist');
  try {
    const raw = await readFile(plistPath, 'utf8');
    const match = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    if (match?.[1]?.trim()) return match[1].trim();
  } catch {
    return '';
  }
  try {
    const { stdout } = await execFileAsync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', plistPath],
      { timeout: 2000 }
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function readValidLiveIdeModelsSnapshot(
  snapshotPath: string,
  installedAppVersion: string
): Promise<LiveIdeModelsSnapshot | null> {
  const cleanInstalled = String(installedAppVersion || '').trim();
  if (!cleanInstalled) return null;
  const info = await lstat(snapshotPath).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser(info)) {
    return null;
  }
  const data = await readOptionalJson<LiveIdeModelsSnapshot>(snapshotPath, 'live-ide-models.json');
  if (!data || typeof data !== 'object' || data.schema !== 1) return null;
  const snapVer = typeof data.appVersion === 'string' ? data.appVersion.trim() : '';
  if (!snapVer || snapVer !== cleanInstalled) return null;
  if (!Array.isArray(data.models) || data.models.length === 0) return null;
  const models: LiveIdeModelSnapshotEntry[] = [];
  for (const m of data.models.slice(0, MAX_LIVE_IDE_SNAPSHOT_MODELS)) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id) continue;
    models.push({
      id,
      displayName: typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : null,
      modelOrAlias: typeof m.modelOrAlias === 'string' && m.modelOrAlias.trim() ? m.modelOrAlias.trim() : null,
      disabled: m.disabled === true || /(?:^|[-_])disabled$/i.test(id),
    });
  }
  if (models.length === 0) return null;
  return {
    schema: 1,
    appVersion: snapVer,
    tier: normalizeCatalogTierLabel(data.tier),
    observedAt: typeof data.observedAt === 'number' && Number.isFinite(data.observedAt) ? data.observedAt : 0,
    models,
  };
}

export async function buildPricingCatalogPayloadSnapshot(params: {
  appPath: string;
  liveIdeModelsPath: string;
  usageManager: UsageStatsManager;
}): Promise<PricingCatalogSnapshotResult> {
  const { appPath, liveIdeModelsPath, usageManager } = params;
  const [installedAppVersion, catalogRaw] = await Promise.all([
    readInstalledAppBundleVersion(appPath),
    usageManager.getRawPricingCatalog(),
  ]);
  const snapshot = await readValidLiveIdeModelsSnapshot(liveIdeModelsPath, installedAppVersion);
  const snapshotInput: PricingCatalogSourceInput | null = snapshot
    ? { tier: snapshot.tier, source: 'snapshot', models: snapshot.models }
    : null;

  const payload = resolvePricingCatalogSnapshot({
    rawPricingTable: catalogRaw.raw,
    publicPricingKeys: catalogRaw.publicKeys,
    live: null,
    snapshot: snapshotInput,
    activeAccount: null,
    poolAccounts: [],
  });

  usageManager.setActiveOfficialModels(
    Object.keys(payload.prices),
    payload.unpricedLiveModels.map((m) => m.key)
  );
  return payload;
}
