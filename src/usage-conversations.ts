import type { SummariesCatalogResult } from './sqlite-worker.js';
import { bt } from './i18n.js';

export interface DbModelUsageBucket {
  dbFile: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedUsd: number;
  firstActiveAt: number;
  lastActiveAt: number;
}

export interface ConversationCatalogMeta {
  conversationId: string;
  title: string;
  workspacePath: string | null;
  workspaceName: string | null;
  projectId: string;
  parentConversationId: string;
  lastModifiedMs: number;
  stepCount: number;
}

export interface ConversationCatalog {
  byId: Map<string, ConversationCatalogMeta>;
  parentByChild: Map<string, string>;
  projectsByKey: Map<string, { id: string; name: string; workspacePath: string | null; latestModifiedMs: number }>;
}

export interface BreakdownModelEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedUsd: number;
}

export interface ProjectUsageBreakdown {
  id: string;
  name: string;
  workspacePath: string | null;
  conversationCount: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  cacheHitRate: number;
  lastActiveAt: number;
  topModels: BreakdownModelEntry[];
}

export interface ConversationUsageBreakdown {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  workspacePath: string | null;
  dbFiles: string[];
  subagentCount: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  cacheHitRate: number;
  firstActiveAt: number;
  lastActiveAt: number;
  byModel: BreakdownModelEntry[];
}

export interface UsageBreakdownResult {
  period: 'today' | '7d' | '30d' | 'all';
  snapshotId?: string;
  generatedAt: number;
  totals: {
    totalTokens: number;
    estimatedUsd: number;
    requestCount: number;
    projectCount: number;
    conversationCount: number;
  };
  projects: ProjectUsageBreakdown[];
  conversations: ConversationUsageBreakdown[];
}

const SYNTHETIC_DB_BASENAMES = new Set([
  'token_usage_archive',
  'recovered_session',
  'recovered_enterprise_session',
]);

export function parsePrimaryWorkspace(rawWorkspaceUris: string): { path: string; name: string } | null {
  const trimmed = typeof rawWorkspaceUris === 'string' ? rawWorkspaceUris.trim() : '';
  if (!trimmed) return null;

  let firstUri = '';
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string' && item.trim()) {
            firstUri = item.trim();
            break;
          }
        }
      }
    } catch {
      return null;
    }
  } else if (/^(?:file:\/\/|\/|[a-zA-Z]:[\\/])/i.test(trimmed)) {
    firstUri = trimmed;
  }
  if (!firstUri) return null;

  let normalized = firstUri.replace(/^file:\/\//i, '');
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep raw URI segment when percent-encoding is malformed.
  }
  normalized = normalized.replace(/\\/g, '/');

  const winDriveMatch = /^\/([a-zA-Z]):(\/.*|$)/.exec(normalized);
  if (winDriveMatch) {
    normalized = `${winDriveMatch[1]!.toUpperCase()}:${winDriveMatch[2] || '/'}`;
  } else if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`;
  }

  if (normalized.length > 1 && !/^[a-zA-Z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }
  if (!normalized) return null;

  const segments = normalized.split('/').filter(Boolean);
  const name = segments.length > 0 ? segments[segments.length - 1]! : normalized;
  return { path: normalized, name };
}

export function normalizeDbFileConversationId(dbFile?: string): string | null {
  const clean = typeof dbFile === 'string' ? dbFile.trim() : '';
  if (!clean) return null;
  const stem = clean.replace(/\.db$/i, '').toLowerCase();
  if (!stem || SYNTHETIC_DB_BASENAMES.has(stem)) return null;
  return stem;
}

export function resolveRootConversationId(convId: string, parentByChild: Map<string, string>): string {
  let current = convId;
  const visited = new Set<string>([current]);
  for (let depth = 0; depth < 16; depth++) {
    const parent = parentByChild.get(current);
    if (!parent || visited.has(parent)) break;
    visited.add(parent);
    current = parent;
  }
  return current;
}

function resolveProjectKeyForMeta(meta: ConversationCatalogMeta | undefined): string {
  if (!meta) return '__unassigned__';
  if (meta.projectId) return `proj:${meta.projectId.toLowerCase()}`;
  if (meta.workspacePath) return `ws:${meta.workspacePath.toLowerCase()}`;
  return '__unassigned__';
}

export function buildConversationCatalog(
  rawInput: SummariesCatalogResult | null | Array<SummariesCatalogResult | null>
): ConversationCatalog {
  const byId = new Map<string, ConversationCatalogMeta>();
  const parentByChild = new Map<string, string>();
  const projectsByKey = new Map<
    string,
    { id: string; name: string; workspacePath: string | null; latestModifiedMs: number }
  >();

  const list = Array.isArray(rawInput) ? rawInput : [rawInput];
  for (const raw of list) {
    if (!raw) continue;
    for (const row of raw.rows) {
      const convId = String(row.conversationId ?? '').trim().toLowerCase();
      if (!convId) continue;
      const ws = parsePrimaryWorkspace(row.workspaceUris);
      const parsedMs = row.lastModifiedTime ? Date.parse(row.lastModifiedTime) : 0;
      const lastModifiedMs = Number.isFinite(parsedMs) ? parsedMs : 0;
      const parentId = String(row.parentConversationId ?? '').trim().toLowerCase();
      const meta: ConversationCatalogMeta = {
        conversationId: convId,
        title: String(row.title ?? '').trim(),
        workspacePath: ws?.path ?? null,
        workspaceName: ws?.name ?? null,
        projectId: String(row.projectId ?? '').trim(),
        parentConversationId: parentId && parentId !== convId ? parentId : '',
        lastModifiedMs,
        stepCount: Number.isFinite(row.stepCount) ? row.stepCount : 0,
      };
      const prevMeta = byId.get(convId);
      if (!prevMeta || meta.lastModifiedMs >= prevMeta.lastModifiedMs) {
        byId.set(convId, meta);
      }
      if (meta.parentConversationId) {
        parentByChild.set(convId, meta.parentConversationId);
      }

      const projectKey = resolveProjectKeyForMeta(meta);
      if (projectKey !== '__unassigned__' && ws) {
        const existingProj = projectsByKey.get(projectKey);
        if (!existingProj || lastModifiedMs > existingProj.latestModifiedMs) {
          projectsByKey.set(projectKey, {
            id: projectKey,
            name: ws.name,
            workspacePath: ws.path,
            latestModifiedMs: lastModifiedMs,
          });
        }
      }
    }
    for (const pair of raw.parents) {
      const childId = String(pair.childId ?? '').trim().toLowerCase();
      const parentId = String(pair.parentId ?? '').trim().toLowerCase();
      if (childId && parentId && childId !== parentId) {
        parentByChild.set(childId, parentId);
      }
    }
  }

  return { byId, parentByChild, projectsByKey };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function calcCacheHitRate(inputTokens: number, cachedTokens: number, cacheWriteTokens: number): number {
  const denom = inputTokens + cachedTokens + cacheWriteTokens;
  return denom > 0 ? Math.round((cachedTokens / denom) * 1000) / 10 : 0;
}

function mergeModelBucket(target: Map<string, BreakdownModelEntry>, bucket: DbModelUsageBucket): void {
  let entry = target.get(bucket.model);
  if (!entry) {
    entry = {
      model: bucket.model,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      estimatedUsd: 0,
    };
    target.set(bucket.model, entry);
  }
  entry.inputTokens += bucket.inputTokens;
  entry.outputTokens += bucket.outputTokens;
  entry.cachedTokens += bucket.cachedTokens;
  entry.cacheWriteTokens += bucket.cacheWriteTokens;
  entry.totalTokens += bucket.totalTokens;
  entry.requestCount += bucket.requestCount;
  entry.estimatedUsd += bucket.estimatedUsd;
}

function finalizeModelEntries(map: Map<string, BreakdownModelEntry>): BreakdownModelEntry[] {
  return [...map.values()]
    .map(m => ({ ...m, estimatedUsd: roundUsd(m.estimatedUsd) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.estimatedUsd - a.estimatedUsd || a.model.localeCompare(b.model));
}

export function buildUsageBreakdownFromDbBuckets(
  buckets: DbModelUsageBucket[],
  catalog: ConversationCatalog,
  options: {
    period: 'today' | '7d' | '30d' | 'all';
    snapshotId?: string;
    generatedAt: number;
    projectId?: string;
  }
): UsageBreakdownResult {
  type MutableConvAcc = {
    id: string;
    projectKey: string;
    dbFiles: Set<string>;
    subagentIds: Set<string>;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    estimatedUsd: number;
    firstActiveAt: number;
    lastActiveAt: number;
    models: Map<string, BreakdownModelEntry>;
  };

  type MutableProjAcc = {
    id: string;
    name: string;
    workspacePath: string | null;
    convIds: Set<string>;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    estimatedUsd: number;
    lastActiveAt: number;
    models: Map<string, BreakdownModelEntry>;
  };

  const convMap = new Map<string, MutableConvAcc>();
  const projMap = new Map<string, MutableProjAcc>();
  const unassignedLabel = bt('usage.breakdown.unassigned_project');

  for (const bucket of buckets) {
    if (bucket.totalTokens <= 0 && bucket.requestCount <= 0) continue;
    const convId = normalizeDbFileConversationId(bucket.dbFile);
    const rootId = convId ? resolveRootConversationId(convId, catalog.parentByChild) : '__unattributed__';
    const rootMeta = rootId !== '__unattributed__' ? catalog.byId.get(rootId) : undefined;
    const selfMeta = convId ? catalog.byId.get(convId) : undefined;
    const projectKey = resolveProjectKeyForMeta(rootMeta ?? selfMeta);
    const projectMeta = catalog.projectsByKey.get(projectKey);
    const projectName = projectMeta?.name ?? (rootMeta?.workspaceName ?? selfMeta?.workspaceName ?? unassignedLabel);
    const workspacePath = projectMeta?.workspacePath ?? rootMeta?.workspacePath ?? selfMeta?.workspacePath ?? null;

    let convAcc = convMap.get(rootId);
    if (!convAcc) {
      convAcc = {
        id: rootId,
        projectKey,
        dbFiles: new Set<string>(),
        subagentIds: new Set<string>(),
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        estimatedUsd: 0,
        firstActiveAt: 0,
        lastActiveAt: 0,
        models: new Map(),
      };
      convMap.set(rootId, convAcc);
    }
    if (bucket.dbFile) convAcc.dbFiles.add(bucket.dbFile);
    if (convId && convId !== rootId) convAcc.subagentIds.add(convId);
    convAcc.requestCount += bucket.requestCount;
    convAcc.inputTokens += bucket.inputTokens;
    convAcc.outputTokens += bucket.outputTokens;
    convAcc.cachedTokens += bucket.cachedTokens;
    convAcc.cacheWriteTokens += bucket.cacheWriteTokens;
    convAcc.totalTokens += bucket.totalTokens;
    convAcc.estimatedUsd += bucket.estimatedUsd;
    if (bucket.firstActiveAt > 0 && (convAcc.firstActiveAt === 0 || bucket.firstActiveAt < convAcc.firstActiveAt)) {
      convAcc.firstActiveAt = bucket.firstActiveAt;
    }
    if (bucket.lastActiveAt > convAcc.lastActiveAt) {
      convAcc.lastActiveAt = bucket.lastActiveAt;
    }
    mergeModelBucket(convAcc.models, bucket);

    let projAcc = projMap.get(projectKey);
    if (!projAcc) {
      projAcc = {
        id: projectKey,
        name: projectName,
        workspacePath,
        convIds: new Set<string>(),
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        estimatedUsd: 0,
        lastActiveAt: 0,
        models: new Map(),
      };
      projMap.set(projectKey, projAcc);
    }
    projAcc.convIds.add(rootId);
    projAcc.requestCount += bucket.requestCount;
    projAcc.inputTokens += bucket.inputTokens;
    projAcc.outputTokens += bucket.outputTokens;
    projAcc.cachedTokens += bucket.cachedTokens;
    projAcc.cacheWriteTokens += bucket.cacheWriteTokens;
    projAcc.totalTokens += bucket.totalTokens;
    projAcc.estimatedUsd += bucket.estimatedUsd;
    if (bucket.lastActiveAt > projAcc.lastActiveAt) {
      projAcc.lastActiveAt = bucket.lastActiveAt;
    }
    mergeModelBucket(projAcc.models, bucket);
  }

  const projects: ProjectUsageBreakdown[] = [...projMap.values()]
    .map(p => ({
      id: p.id,
      name: p.name,
      workspacePath: p.workspacePath,
      conversationCount: p.convIds.size,
      requestCount: p.requestCount,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      cachedTokens: p.cachedTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      totalTokens: p.totalTokens,
      estimatedUsd: roundUsd(p.estimatedUsd),
      cacheHitRate: calcCacheHitRate(p.inputTokens, p.cachedTokens, p.cacheWriteTokens),
      lastActiveAt: p.lastActiveAt,
      topModels: finalizeModelEntries(p.models),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.estimatedUsd - a.estimatedUsd || b.lastActiveAt - a.lastActiveAt);

  const allConversations: ConversationUsageBreakdown[] = [...convMap.values()]
    .map(c => {
      const rootMeta = c.id !== '__unattributed__' ? catalog.byId.get(c.id) : undefined;
      const proj = projMap.get(c.projectKey);
      const title = rootMeta?.title
        ? rootMeta.title
        : c.id === '__unattributed__'
          ? bt('usage.breakdown.archived_or_unknown')
          : bt('usage.breakdown.untitled_conversation', { id: c.id.slice(0, 8) });
      return {
        id: c.id,
        title,
        projectId: c.projectKey,
        projectName: proj?.name ?? unassignedLabel,
        workspacePath: proj?.workspacePath ?? rootMeta?.workspacePath ?? null,
        dbFiles: [...c.dbFiles].sort(),
        subagentCount: c.subagentIds.size,
        requestCount: c.requestCount,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cachedTokens: c.cachedTokens,
        cacheWriteTokens: c.cacheWriteTokens,
        totalTokens: c.totalTokens,
        estimatedUsd: roundUsd(c.estimatedUsd),
        cacheHitRate: calcCacheHitRate(c.inputTokens, c.cachedTokens, c.cacheWriteTokens),
        firstActiveAt: c.firstActiveAt,
        lastActiveAt: c.lastActiveAt,
        byModel: finalizeModelEntries(c.models),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.lastActiveAt - a.lastActiveAt);

  const filterProjectId = options.projectId && options.projectId !== 'all' ? options.projectId : undefined;
  const conversations = filterProjectId
    ? allConversations.filter(c => c.projectId === filterProjectId)
    : allConversations;

  let totalTokens = 0;
  let estimatedUsd = 0;
  let requestCount = 0;
  for (const p of projects) {
    totalTokens += p.totalTokens;
    estimatedUsd += p.estimatedUsd;
    requestCount += p.requestCount;
  }

  return {
    period: options.period,
    snapshotId: options.snapshotId,
    generatedAt: options.generatedAt,
    totals: {
      totalTokens,
      estimatedUsd: roundUsd(estimatedUsd),
      requestCount,
      projectCount: projects.length,
      conversationCount: allConversations.length,
    },
    projects,
    conversations,
  };
}
