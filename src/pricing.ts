import { normalizeModelId } from './model-identity.js';
import { MODEL_PRICES, getEffectiveModelPriceAlias, FEED_MODEL_KEYS, CATALOG_PRICING_VERSION } from './model-catalog.js';
import { bt, getActiveLocale } from './i18n.js';

export interface ApiPricingContextTier {
  /** 单步总输入规模阈值（promptTokens > thresholdTokens 触发；inclusive=true 时为 >=） */
  thresholdTokens: number;
  inclusive?: boolean;
  input: number;  // 每 1M Tokens 美元
  output: number; // 每 1M Tokens 美元
  cached: number; // 每 1M Tokens 美元
  cacheWrite?: number;
}

export interface ApiPricing {
  model: string;
  input: number;  // 每 1M Tokens 美元
  output: number; // 每 1M Tokens 美元
  cached: number; // 每 1M Tokens 美元
  cacheWrite?: number;
  /** 可选长上下文阶梯定价（如 >200k Tokens），未配置时沿用平铺单价 */
  contextTiers?: ApiPricingContextTier[];
  provenance?: {
    sourceUrl?: string;
    platform?: string;
    platformEn?: string;
    conditions?: string;
    conditionsEn?: string;
    checkedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    verification?: 'confirmed' | 'historical' | 'user';
  };
  intervals?: ApiPricingInterval[];
}

export interface ApiPricingInterval {
  model?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
  contextTiers?: ApiPricingContextTier[];
  provenance?: {
    sourceUrl?: string;
    platform?: string;
    platformEn?: string;
    conditions?: string;
    conditionsEn?: string;
    checkedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    verification?: 'confirmed' | 'historical' | 'user';
  };
}

export type ApiPricingEntry = ApiPricing | ApiPricingInterval[];

export const DEFAULT_PRICING_FEED_URLS = [
  'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json',
  'https://cdn.jsdelivr.net/gh/Enzoo404/gravitybox@main/assets/pricing-feed.json',
];

export const PRICING_METADATA = {
  version: CATALOG_PRICING_VERSION || '2026-11-13',
  sourceUrl: 'https://cloud.google.com/vertex-ai/pricing',
  effectiveDate: '2026-11-01',
  currency: 'USD',
  conditions: 'List prices for standard context tier, input caching enabled, per million tokens',
};

export const DEFAULT_API_PRICES: Record<string, ApiPricingEntry> = MODEL_PRICES;

function mergeIntervalProvenance(
  iv: ApiPricingInterval,
  baseProv?: ApiPricing['provenance']
): ApiPricing['provenance'] | undefined {
  if (!baseProv) return iv.provenance;
  const mergedProv: NonNullable<ApiPricing['provenance']> = {
    ...baseProv,
    ...(iv.provenance ?? {}),
  };
  if (!iv.provenance?.validUntil) {
    if (iv.validUntil) mergedProv.validUntil = iv.validUntil;
    else delete mergedProv.validUntil;
  }
  if (!iv.provenance?.validFrom) {
    if (iv.validFrom) mergedProv.validFrom = iv.validFrom;
    else delete mergedProv.validFrom;
  }
  return mergedProv;
}

export function isTemporalPricingEntry(entry: ApiPricingEntry | undefined): boolean {
  if (!entry) return false;
  if (Array.isArray(entry)) return entry.length > 0;
  return Boolean(
    (Array.isArray(entry.intervals) && entry.intervals.length > 0) ||
      entry.provenance?.validFrom ||
      entry.provenance?.validUntil
  );
}

export function resolveContextTierPricing(pricing: ApiPricing, promptTokens: number): ApiPricing {
  if (!pricing.contextTiers?.length || !Number.isFinite(promptTokens) || promptTokens < 0) {
    return pricing;
  }
  let matched: ApiPricingContextTier | null = null;
  for (const tier of pricing.contextTiers) {
    const hit = tier.inclusive ? promptTokens >= tier.thresholdTokens : promptTokens > tier.thresholdTokens;
    if (hit && (!matched || tier.thresholdTokens >= matched.thresholdTokens)) {
      matched = tier;
    }
  }
  if (!matched) return pricing;
  return {
    ...pricing,
    input: matched.input,
    output: matched.output,
    cached: matched.cached,
    ...(matched.cacheWrite !== undefined ? { cacheWrite: matched.cacheWrite } : {}),
  };
}

export function resolvePricingForTimestamp(
  entry: ApiPricingEntry | undefined,
  timestampSeconds: number,
  fallbackModelName = ''
): ApiPricing | null {
  if (!entry || !Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  const intervals: ApiPricingInterval[] | null = Array.isArray(entry)
    ? entry
    : (entry.intervals && Array.isArray(entry.intervals) && entry.intervals.length > 0)
    ? entry.intervals
    : null;

  if (!intervals) {
    if (Array.isArray(entry)) return null;
    return entry;
  }
  if (intervals.length === 0) return null;

  const eventMs = timestampSeconds * 1000;

  let match: ApiPricingInterval | null = null;
  for (const interval of intervals) {
    const fromMs = interval.validFrom ? Date.parse(interval.validFrom) : Number.NEGATIVE_INFINITY;
    const untilMs = interval.validUntil ? Date.parse(interval.validUntil) : Number.POSITIVE_INFINITY;
    if (eventMs >= fromMs && eventMs < untilMs) {
      match = interval;
      break;
    }
  }

  // 缝隙容错保护：若刚好落在相邻两区间之间不超过 1000ms（1秒）的跨度（例如 23:59:59 到次日 00:00:00）
  if (!match) {
    for (const interval of intervals) {
      if (interval.validUntil) {
        const untilMs = Date.parse(interval.validUntil);
        const fromMs = interval.validFrom ? Date.parse(interval.validFrom) : Number.NEGATIVE_INFINITY;
        if (eventMs >= fromMs && eventMs >= untilMs && eventMs <= untilMs + 1000) {
          match = interval;
          break;
        }
      }
    }
  }

  if (!match) return null;

  const baseProv = !Array.isArray(entry) ? entry.provenance : undefined;
  const mergedProvenance = mergeIntervalProvenance(match, baseProv);
  const tierSource = match.contextTiers !== undefined
    ? match.contextTiers
    : !Array.isArray(entry) && entry.contextTiers !== undefined
      ? entry.contextTiers
      : undefined;

  return {
    model: match.model ?? fallbackModelName ?? (!Array.isArray(entry) ? entry.model : ''),
    input: match.input,
    output: match.output,
    cached: match.cached,
    ...(match.cacheWrite !== undefined ? { cacheWrite: match.cacheWrite } : {}),
    ...(tierSource !== undefined ? { contextTiers: tierSource } : {}),
    provenance: mergedProvenance,
    ...(entry && !Array.isArray(entry) && entry.intervals ? { intervals: entry.intervals } : {}),
  };
}

export function priceStatus(price: ApiPricing | ApiPricingInterval[], now = Date.now()) {
  const p = Array.isArray(price) ? resolvePricingForTimestamp(price, Math.floor(now / 1000)) : price;
  if (!p) return 'historical';
  if (p.provenance?.validUntil && Date.parse(p.provenance.validUntil) < now) return 'expired';
  return p.provenance?.verification === 'confirmed' ? 'confirmed' : p.provenance?.verification === 'user' ? 'user' : 'historical';
}

const SORTED_DEFAULT_PRICE_KEYS = Object.keys(DEFAULT_API_PRICES).sort((a, b) => b.length - a.length);
const PRICING_TABLE_SORTED_KEYS_CACHE = new WeakMap<object, readonly string[]>();
const SUFFIX_VARIANT_RE = /^(?:xhigh|extra-high|extra-low|high|medium|low|thinking|latest|preview|trial|\d{8}|\d{4}-\d{2}-\d{2}|\d{3})(?:-thinking)?(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}))?$/;

function getSortedPricingTableKeys(pricingTable: Record<string, ApiPricingEntry>): readonly string[] {
  if (pricingTable === DEFAULT_API_PRICES) return SORTED_DEFAULT_PRICE_KEYS;
  let cached = PRICING_TABLE_SORTED_KEYS_CACHE.get(pricingTable);
  if (!cached) {
    const union = new Set<string>(SORTED_DEFAULT_PRICE_KEYS);
    for (const k of Object.keys(pricingTable)) {
      const norm = normalizeModelId(k);
      if (norm) union.add(norm);
    }
    cached = [...union].sort((a, b) => b.length - a.length);
    PRICING_TABLE_SORTED_KEYS_CACHE.set(pricingTable, cached);
  }
  return cached;
}

function matchPricingKeysWithCandidates(modelName: string, sortedCandidateKeys: readonly string[]): string {
  if (!modelName || modelName.includes('未知模型') || modelName.toLowerCase().includes('unknown')) {
    return '';
  }
  const directAlias = getEffectiveModelPriceAlias(modelName);
  if (directAlias) return directAlias;
  // Only audited suffixes may inherit a base model price. Custom/experimental suffixes stay unknown.
  const lower = normalizeModelId(modelName);
  const lowerAlias = getEffectiveModelPriceAlias(lower);
  if (lowerAlias) return lowerAlias;
  for (const key of sortedCandidateKeys) {
    if (lower === key) return key;
    if (lower.startsWith(key + '-') && SUFFIX_VARIANT_RE.test(lower.slice(key.length + 1))) return key;
  }
  return lower;
}

/**
 * 模型价格归一化匹配算法（支持叠加远端/自定义价格表候选键）
 */
export function matchPricingKeys(modelName: string, extraKeys?: Iterable<string>): string {
  if (!extraKeys) {
    return matchPricingKeysWithCandidates(modelName, SORTED_DEFAULT_PRICE_KEYS);
  }
  const union = new Set<string>(SORTED_DEFAULT_PRICE_KEYS);
  for (const rawKey of extraKeys) {
    const norm = normalizeModelId(String(rawKey));
    if (norm) union.add(norm);
  }
  const sorted = union.size === SORTED_DEFAULT_PRICE_KEYS.length
    ? SORTED_DEFAULT_PRICE_KEYS
    : [...union].sort((a, b) => b.length - a.length);
  return matchPricingKeysWithCandidates(modelName, sorted);
}

function isValidRateValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 500.0;
}

function validateContextTiers(tiers: unknown, key: string): void {
  if (!Array.isArray(tiers)) throw Error(bt('pricing.err.interval_entry_invalid', { key }));
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) throw Error(bt('pricing.err.interval_entry_invalid', { key }));
    const rec = tier as unknown as Record<string, unknown>;
    if (typeof rec.thresholdTokens !== 'number' || !Number.isSafeInteger(rec.thresholdTokens) || rec.thresholdTokens <= 0) {
      throw Error(bt('pricing.err.interval_entry_invalid', { key }));
    }
    if (!['input', 'output', 'cached'].every(k => isValidRateValue(rec[k]))) {
      throw Error(bt('pricing.err.interval_rate_invalid', { key }));
    }
    if (rec.cacheWrite !== undefined && !isValidRateValue(rec.cacheWrite)) {
      throw Error(bt('pricing.err.interval_cache_write_invalid', { key }));
    }
  }
}

export function calculateEstimatedUsd(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  pricing: ApiPricing | ApiPricingInterval[],
  cacheWriteTokens = 0
): number {
  let resolvedPricing: ApiPricing;
  if (Array.isArray(pricing)) {
    const r = resolvePricingForTimestamp(pricing, Math.floor(Date.now() / 1000));
    if (!r) throw Error(bt('pricing.err.usage_or_rate_invalid'));
    resolvedPricing = r;
  } else {
    resolvedPricing = pricing;
  }
  if (![inputTokens, outputTokens, cachedTokens, cacheWriteTokens].every(n => Number.isFinite(n) && n >= 0)) {
    throw Error(bt('pricing.err.usage_or_rate_invalid'));
  }
  const effectivePricing = resolveContextTierPricing(resolvedPricing, inputTokens + cachedTokens + cacheWriteTokens);
  if (cacheWriteTokens > 0 && (!Number.isFinite(effectivePricing.cacheWrite) || effectivePricing.cacheWrite! < 0)) {
    throw new Error(bt('pricing.err.cache_write_unconfigured'));
  }
  if (![effectivePricing.input, effectivePricing.output, effectivePricing.cached].every(n => Number.isFinite(n) && n >= 0)) {
    throw Error(bt('pricing.err.usage_or_rate_invalid'));
  }
  const cost =
    (inputTokens * effectivePricing.input +
      outputTokens * effectivePricing.output +
      cachedTokens * effectivePricing.cached +
      cacheWriteTokens * (effectivePricing.cacheWrite ?? 0)) /
    1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

export function validatePricingIntervals(value: ApiPricingInterval[], key: string): void {
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error(bt('pricing.err.interval_entry_invalid', { key }));
    if (!['input', 'output', 'cached'].every(k => isValidRateValue((item as unknown as Record<string, unknown>)[k]))) {
      throw Error(bt('pricing.err.interval_rate_invalid', { key }));
    }
    if (item.cacheWrite !== undefined && !isValidRateValue(item.cacheWrite)) {
      throw Error(bt('pricing.err.interval_cache_write_invalid', { key }));
    }
    if (item.contextTiers !== undefined) {
      validateContextTiers(item.contextTiers, key);
    }
    if (item.validFrom !== undefined && item.validFrom !== null && (typeof item.validFrom !== 'string' || isNaN(Date.parse(item.validFrom)))) {
      throw Error(bt('pricing.err.valid_from_invalid', { key }));
    }
    if (item.validUntil !== undefined && item.validUntil !== null && (typeof item.validUntil !== 'string' || isNaN(Date.parse(item.validUntil)))) {
      throw Error(bt('pricing.err.valid_until_invalid', { key }));
    }
  }
}

export function validateRawPrices(table: unknown): Record<string, ApiPricingEntry> {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw Error(bt('pricing.err.table_invalid'));
  const result: Record<string, ApiPricingEntry> = {};
  for (const [key, value] of Object.entries(table)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error(bt('pricing.err.illegal_entry_name', { key }));
    if (Array.isArray(value)) {
      if (value.length === 0) throw Error(bt('pricing.err.interval_array_empty', { key }));
      validatePricingIntervals(value, key);
      result[key] = value as ApiPricingInterval[];
    } else {
      const price = value as ApiPricing;
      const priceRec = price as unknown as Record<string, unknown>;
      if (!price || typeof price !== 'object' || typeof price.model !== 'string' || !['input', 'output', 'cached'].every(k => isValidRateValue(priceRec[k])) || (price.cacheWrite !== undefined && !isValidRateValue(price.cacheWrite))) {
        throw Error(bt('pricing.err.entry_rate_invalid', { key }));
      }
      if (price.contextTiers !== undefined) {
        validateContextTiers(price.contextTiers, key);
      }
      if (price.intervals !== undefined) {
        if (!Array.isArray(price.intervals) || price.intervals.length === 0) {
          throw Error(bt('pricing.err.interval_array_empty', { key }));
        }
        validatePricingIntervals(price.intervals, key);
      }
      result[key] = price;
    }
  }
  return result;
}

export function mergePricingEntries(
  merged: Record<string, ApiPricingEntry>,
  entries: object,
  warningPrefix: string,
  warnings: string[]
): void {
  for (const [key, value] of Object.entries(entries)) {
    try {
      const validated = validateRawPrices({ [key]: value });
      const incoming = validated[key];
      const base = merged[key];
      const baseProv = base && !Array.isArray(base) ? base.provenance : undefined;
      if (incoming && baseProv) {
        if (Array.isArray(incoming)) {
          for (const iv of incoming) {
            iv.provenance = mergeIntervalProvenance(iv, baseProv);
          }
        } else {
          if (incoming.provenance) {
            incoming.provenance = { ...baseProv, ...incoming.provenance };
          } else {
            incoming.provenance = { ...baseProv };
          }
          if (Array.isArray(incoming.intervals)) {
            for (const iv of incoming.intervals) {
              iv.provenance = mergeIntervalProvenance(iv, baseProv);
            }
          }
        }
      }
      Object.assign(merged, validated);
    } catch {
      warnings.push(warningPrefix + key);
    }
  }
}

export function canonicalActivePricingKeys(
  modelIds: Iterable<string> | null | undefined,
  extraPricingKeys?: Iterable<string>
): Set<string> {
  const source = modelIds ? Array.from(modelIds) : [];
  const keys = new Set<string>();
  for (const rawId of source) {
    const trimmed = String(rawId).trim();
    if (!trimmed) continue;
    const baseId = trimmed.replace(/(?:^|[-_])disabled$/i, '').trim() || trimmed;
    const matched = matchPricingKeys(baseId, extraPricingKeys);
    if (matched) keys.add(matched);
    keys.add(normalizeModelId(baseId));
  }
  if (keys.size === 0) {
    for (const key of FEED_MODEL_KEYS) keys.add(key);
  }
  return keys;
}

export function lookupPricingEntry(
  pricingTable: Record<string, ApiPricingEntry>,
  modelName: string
): { key: string; entry: ApiPricingEntry } | null {
  if (!modelName || modelName.includes('未知模型') || modelName.toLowerCase().includes('unknown')) {
    return null;
  }
  const direct = pricingTable[modelName];
  if (direct) return { key: modelName, entry: direct };
  const normalizedDirect = normalizeModelId(modelName);
  if (normalizedDirect && pricingTable[normalizedDirect]) {
    return { key: normalizedDirect, entry: pricingTable[normalizedDirect]! };
  }
  const canonicalKey = matchPricingKeysWithCandidates(modelName, getSortedPricingTableKeys(pricingTable));
  const matched = pricingTable[canonicalKey];
  if (matched) return { key: canonicalKey, entry: matched };
  return null;
}

export function resolvePricingFromTable(
  pricingTable: Record<string, ApiPricingEntry>,
  modelName: string,
  timestampSeconds: number
): ApiPricing | null {
  const found = lookupPricingEntry(pricingTable, modelName);
  if (!found) return null;
  return resolvePricingForTimestamp(found.entry, timestampSeconds, found.key);
}

const PLATFORM_EN_MAP: Record<string, string> = {
  'Google Cloud 标准 Global API': 'Google Cloud Standard Global API',
  'Anthropic 标准 API': 'Anthropic Standard API',
  'OpenAI 标准 API': 'OpenAI Standard API',
  '开放权重模型 API 参考基准': 'Open-Weight Model API Reference Benchmark',
};

function translateProvenanceConditionsToEn(text: string): string {
  if (!/[\u4e00-\u9fff]/.test(text)) return text;
  return text
    .replace(/Google Cloud 官方推广期标准 Global API 文本基准/g, 'Google Cloud official promotional Global API text benchmark')
    .replace(/Google Cloud 官方 ([A-Za-z0-9 ._-]+) 标准 Global API 文本基准/g, 'Google Cloud official $1 standard Global API text benchmark')
    .replace(/Google Cloud 官方 ([A-Za-z0-9 ._-]+) 高阶推理模型标准基准/g, 'Google Cloud official $1 reasoning model standard benchmark')
    .replace(/Google Cloud 官方 ([A-Za-z0-9 ._-]+) 标准文本基准/g, 'Google Cloud official $1 standard text benchmark')
    .replace(/Google Cloud 官方 ([A-Za-z0-9 ._-]+) 标准定价/g, 'Google Cloud official $1 standard pricing')
    .replace(/Anthropic 官方 ([A-Za-z0-9 ._-]+) 标准文本基准/g, 'Anthropic official $1 standard text benchmark')
    .replace(/Anthropic 官方 ([A-Za-z0-9 ._-]+) 标准 API 最新降价/g, 'Anthropic official $1 standard API updated pricing')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 官方推广期文本基准做等效估算/g, 'Estimated from $1 official promotional text benchmark')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 官方正式定价做等效估算/g, 'Estimated from $1 official standard pricing')
    .replace(/前期参考 ([A-Za-z0-9 ._-]+) 系列标准 API 文本基准估算/g, 'Previously estimated from $1 series standard API text benchmark')
    .replace(/前期参考 ([A-Za-z0-9 ._-]+) 标准 API 文本基准估算/g, 'Previously estimated from $1 standard API text benchmark')
    .replace(/参考同类开放权重 120B 模型公开 API 基准估算/g, 'Estimated from comparable open-weight 120B model public API benchmarks')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 系列公开文本基准估算/g, 'Estimated from $1 series public text benchmark')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 系列文本基准估算/g, 'Estimated from $1 series text benchmark')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 标准 Global API 文本基准估算/g, 'Estimated from $1 standard Global API text benchmark')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 标准文本基准估算/g, 'Estimated from $1 standard text benchmark')
    .replace(/基础 ([A-Za-z0-9 ._-]+) 文本参考价；内部 -n 标识按同系列 Flash 基准估算/g, 'Base $1 text reference rate; internal -n variant estimated from Flash series benchmark')
    .replace(/基础 ([A-Za-z0-9 ._-]+) 标准全量定价/g, 'Base $1 standard list pricing')
    .replace(/Google Cloud 标准文本参考价；(\d{4}-\d{2}-\d{2})为本地核价起点，不代表官方调价日期/g, 'Google Cloud standard text reference rate; $1 marks local audit baseline rather than an official price-change date')
    .replace(/沿用历史基准；不代表所有区域、长上下文或缓存写入单价；需按来源逐项核对/g, 'Historical benchmark; excludes regional, long-context, or cache-write surcharges; verify against official source')
    .replace(/沿用历史基准；缓存读取 (\$[0-9.]+\/MTok)，缓存写入 (\$[0-9.]+\/MTok)/g, 'Historical benchmark; cache read $1, cache write $2')
    .replace(/文本基准；缓存读取 (\$[0-9.]+\/MTok)，缓存写入 (\$[0-9.]+\/MTok)；不含工具费用/g, 'Text benchmark; cache read $1, cache write $2; excludes tool charges')
    .replace(/文本基准；输入\/输出采用限时优惠；缓存采用缓存读取基准，优惠截至(\d{4}-\d{2}-\d{2})/g, 'Text benchmark; promotional input/output rate and cache-read rate through $1')
    .replace(/文本基准；输入\/输出采用限时优惠；优惠截至(\d{4}-\d{2}-\d{2})/g, 'Text benchmark; promotional input/output rate through $1')
    .replace(/文本基准；恢复为标准全量定价/g, 'Text benchmark; reverted to standard list pricing')
    .replace(/标准全量定价/g, 'Standard list pricing')
    .replace(/（优惠截至(\d{4}-\d{2}-\d{2})）/g, ' (promotional through $1)')
    .replace(/；优惠截至(\d{4}-\d{2}-\d{2})/g, '; promotional through $1')
    .replace(/（(\d{4}-\d{2}-\d{2})生效）/g, ' (effective $1)')
    .replace(/（<=200k Tokens；缓存写入 (\$[0-9.]+) 自 (\d{4}-\d{2}-\d{2}) 起生效）/g, ' (<=200k tokens; cache write $1 effective $2)')
    .replace(/（<=200k Tokens；含缓存写入 (\$[0-9.]+)）/g, ' (<=200k tokens; includes cache write $1)')
    .replace(/\(<=200k Tokens\)/g, '(<=200k tokens)')
    .replace(/（含 Medium \/ High \/ Thinking 变体）/g, ' (including Medium / High / Thinking variants)')
    .replace(/；/g, '; ');
}

export function localizePricingProvenance(
  provenance: ApiPricing['provenance'] | null | undefined,
  locale: string = getActiveLocale()
): ApiPricing['provenance'] | null | undefined {
  if (!provenance || locale !== 'en') return provenance;
  const nextPlatform =
    provenance.platformEn ??
    (provenance.platform ? (PLATFORM_EN_MAP[provenance.platform] ?? provenance.platform) : provenance.platform);
  const nextConditions =
    provenance.conditionsEn ??
    (provenance.conditions ? translateProvenanceConditionsToEn(provenance.conditions) : provenance.conditions);
  if (nextPlatform === provenance.platform && nextConditions === provenance.conditions) {
    return provenance;
  }
  return {
    ...provenance,
    ...(nextPlatform !== undefined ? { platform: nextPlatform } : {}),
    ...(nextConditions !== undefined ? { conditions: nextConditions } : {}),
  };
}

export function localizePricingTable(
  prices: Record<string, ApiPricing>,
  locale: string = getActiveLocale()
): Record<string, ApiPricing> {
  if (locale !== 'en') return prices;
  const out: Record<string, ApiPricing> = {};
  for (const [key, entry] of Object.entries(prices)) {
    out[key] = {
      ...entry,
      ...(entry.provenance ? { provenance: localizePricingProvenance(entry.provenance, locale) ?? undefined } : {}),
      ...(Array.isArray(entry.intervals)
        ? {
            intervals: entry.intervals.map((iv) => ({
              ...iv,
              ...(iv.provenance ? { provenance: localizePricingProvenance(iv.provenance, locale) ?? undefined } : {}),
            })),
          }
        : {}),
    };
  }
  return out;
}
