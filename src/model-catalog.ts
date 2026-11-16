import { readFileSync } from 'node:fs';
import type { ApiPricingEntry } from './pricing.js';
import { bt } from './i18n.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MIN_REMOTE_CAPACITY_TOKENS = 4_096;
const MAX_REMOTE_CAPACITY_TOKENS = 2_000_000;

export interface RemoteModelMetadataSpec {
  displayName?: string;
  capacityTokens?: number;
}

const catalog = JSON.parse(readFileSync(new URL('../assets/model-catalog.json', import.meta.url), 'utf8'));
if (catalog.schema !== 1 || !catalog.names || !catalog.prices) throw Error(bt('model_catalog.err.invalid'));

export const MODEL_NAMES = Object.assign(Object.create(null), catalog.names) as Record<string, string>;
export const MODEL_PRICES = Object.assign(Object.create(null), catalog.prices) as Record<string, ApiPricingEntry>;
export const MODEL_PRICE_ALIASES = catalog.aliases as Record<string, string>;
export const FEED_MODEL_KEYS = Object.freeze(Array.isArray(catalog.feedModels) ? [...catalog.feedModels] : []) as readonly string[];
export const CATALOG_PRICING_VERSION = typeof catalog.pricingVersion === 'string' ? catalog.pricingVersion : '';

const remoteAliases: Record<string, string> = Object.create(null);
const remoteModelSpecs: Record<string, RemoteModelMetadataSpec> = Object.create(null);

function isSafeCatalogKey(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 128 && !FORBIDDEN_KEYS.has(raw);
}

export function sanitizeRemoteModelMetadata(raw: unknown): {
  aliases?: Record<string, string>;
  models?: Record<string, RemoteModelMetadataSpec>;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  let aliasesOut: Record<string, string> | undefined;
  if (source.aliases && typeof source.aliases === 'object' && !Array.isArray(source.aliases)) {
    for (const [aliasKey, targetVal] of Object.entries(source.aliases as Record<string, unknown>)) {
      const cleanAlias = aliasKey.trim();
      const cleanTarget = typeof targetVal === 'string' ? targetVal.trim() : '';
      if (!isSafeCatalogKey(cleanAlias) || !isSafeCatalogKey(cleanTarget)) continue;
      aliasesOut ??= {};
      aliasesOut[cleanAlias] = cleanTarget;
    }
  }
  let modelsOut: Record<string, RemoteModelMetadataSpec> | undefined;
  if (source.models && typeof source.models === 'object' && !Array.isArray(source.models)) {
    for (const [modelKey, metaVal] of Object.entries(source.models as Record<string, unknown>)) {
      const cleanKey = modelKey.trim().toLowerCase();
      if (!isSafeCatalogKey(cleanKey) || !metaVal || typeof metaVal !== 'object' || Array.isArray(metaVal)) continue;
      const rec = metaVal as Record<string, unknown>;
      const displayName = typeof rec.displayName === 'string' && rec.displayName.trim().length > 0 && rec.displayName.trim().length <= 128
        ? rec.displayName.trim()
        : undefined;
      const rawCap = rec.capacityTokens;
      const capacityTokens = typeof rawCap === 'number'
        && Number.isSafeInteger(rawCap)
        && rawCap >= MIN_REMOTE_CAPACITY_TOKENS
        && rawCap <= MAX_REMOTE_CAPACITY_TOKENS
        ? rawCap
        : undefined;
      if (!displayName && capacityTokens === undefined) continue;
      modelsOut ??= {};
      modelsOut[cleanKey] = {
        ...(displayName ? { displayName } : {}),
        ...(capacityTokens !== undefined ? { capacityTokens } : {}),
      };
    }
  }
  return {
    ...(aliasesOut ? { aliases: aliasesOut } : {}),
    ...(modelsOut ? { models: modelsOut } : {}),
  };
}

export function registerRemoteModelMetadata(
  raw: unknown,
  options?: { onlyNewEntries?: boolean }
): void {
  const sanitized = sanitizeRemoteModelMetadata(raw);
  const onlyNew = options?.onlyNewEntries === true;
  if (sanitized.aliases) {
    for (const [aliasKey, target] of Object.entries(sanitized.aliases)) {
      if (onlyNew && Object.hasOwn(MODEL_PRICE_ALIASES, aliasKey)) continue;
      remoteAliases[aliasKey] = target;
      remoteAliases[aliasKey.toLowerCase()] = target;
    }
  }
  if (sanitized.models) {
    for (const [modelKey, spec] of Object.entries(sanitized.models)) {
      if (onlyNew && Object.hasOwn(MODEL_NAMES, modelKey)) continue;
      remoteModelSpecs[modelKey] = {
        ...(remoteModelSpecs[modelKey] ?? {}),
        ...spec,
      };
    }
  }
}

export function getEffectiveModelPriceAlias(key: string): string | undefined {
  if (!key || FORBIDDEN_KEYS.has(key)) return undefined;
  if (Object.hasOwn(remoteAliases, key)) return remoteAliases[key];
  if (Object.hasOwn(MODEL_PRICE_ALIASES, key)) return MODEL_PRICE_ALIASES[key];
  const lower = key.toLowerCase();
  if (Object.hasOwn(remoteAliases, lower)) return remoteAliases[lower];
  if (Object.hasOwn(MODEL_PRICE_ALIASES, lower)) return MODEL_PRICE_ALIASES[lower];
  return undefined;
}

export function getRemoteModelSpec(normalizedId: string): RemoteModelMetadataSpec | undefined {
  if (!normalizedId || FORBIDDEN_KEYS.has(normalizedId)) return undefined;
  const lower = normalizedId.toLowerCase();
  return Object.hasOwn(remoteModelSpecs, lower) ? remoteModelSpecs[lower] : undefined;
}
