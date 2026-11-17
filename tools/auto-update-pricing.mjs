import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildPricingFeed } from './sync-pricing-feed.mjs';

const DEFAULT_CATALOG_PATH = new URL('../assets/model-catalog.json', import.meta.url);
const DEFAULT_FEED_PATH = new URL('../assets/pricing-feed.json', import.meta.url);
const DEFAULT_REPORT_PATH = new URL('../pricing-watch-alert.json', import.meta.url);

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

const MAX_PAGE_CHARS = 55_000;
const WARN_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const CONSENSUS_TOLERANCE = 0.01;
const CONSENSUS_ABS_EPSILON = 0.0005;
const MIN_PRICE_RATIO = 0.2;
const MAX_PRICE_RATIO = 3.0;
const MAX_SAFE_USD_PER_M = 500;

const VENDOR_CONTENT_ANCHORS = [
  { match: /cloud\.google\.com|ai\.google\.dev/i, anchor: /gemini|token|pricing/i, vendor: 'Google' },
  { match: /anthropic\.com|platform\.claude\.com/i, anchor: /claude|million\s+tokens|mtok|pricing/i, vendor: 'Anthropic' },
  { match: /openai\.com/i, anchor: /gpt|token|pricing/i, vendor: 'OpenAI' },
];

// 内部实验/测试/别名衍生条目不做上游一对一自动调价，避免每日因上游无报价产生误报
const INTERNAL_DERIVATIVE_RE = /(?:^|[-_])(?:trial|control|tiered|safety[-_]le|exp[-_][a-z0-9]+|n|a|default)(?:$|[-_])/i;

// 仅作为新模型雷达候选的现代主流对话模型族，过滤老旧历史模型与非文本模态条目
const MODERN_RADAR_MODEL_RE = /^(?:gemini-(?:3\.[5-9]|4|5)|claude-(?:sonnet|opus|haiku)-[4-9]|gpt-(?:5|6)|o[3-9](?:-|$))/i;
const IGNORED_RADAR_SUFFIX_RE = /(?:batch|audio|realtime|image|video|tts|stt|transcribe|embed|moderation|search|deep-research|computer-use|free|:free|:extended)/i;

// 常见目录 key 到官方/LiteLLM 常见别名的补充映射
const CATALOG_TO_UPSTREAM_ALIASES = {
  'gemini-4-carbon': ['gemini-4-carbon', 'gemini-4.0-carbon', 'gemini-4-pro'],
  'gemini-4-argon': ['gemini-4-argon', 'gemini-4.0-argon'],
  'gemini-4-hydrogen': ['gemini-4-hydrogen', 'gemini-4.0-hydrogen'],
  'gemini-3.8-flash': ['gemini-3.8-flash'],
  'gemini-3.1-pro': ['gemini-3.1-pro', 'gemini-3.1-pro-preview'],
  'gemini-2.5-flash': ['gemini-2.5-flash'],
  'gemini-2.5-pro': ['gemini-2.5-pro'],
  'claude-opus-5-5': ['claude-opus-5-5', 'claude-5-5-opus', 'claude-opus-5.5'],
  'claude-sonnet-5-5': ['claude-sonnet-5-5', 'claude-5-5-sonnet', 'claude-sonnet-5.5'],
  'claude-opus-4-6': ['claude-opus-4-6', 'claude-4-6-opus', 'claude-opus-4.6'],
  'claude-sonnet-4-6': ['claude-sonnet-4-6', 'claude-4-6-sonnet', 'claude-sonnet-4.6'],
  'claude-3-7-sonnet': ['claude-3-7-sonnet', 'claude-3-7-sonnet-latest', 'claude-3-7-sonnet-20250219'],
  'claude-3-5-sonnet': ['claude-3-5-sonnet', 'claude-3-5-sonnet-latest', 'claude-3-5-sonnet-20241022'],
  'claude-3-5-haiku': ['claude-3-5-haiku', 'claude-3-5-haiku-latest', 'claude-3-5-haiku-20241022'],
  'gpt-4o': ['gpt-4o'],
  'gpt-4o-mini': ['gpt-4o-mini'],
  'gpt-oss-120b': ['gpt-oss-120b'],
};

const GEMINI_EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pageParsedOk: { type: 'BOOLEAN' },
    notes: { type: 'STRING' },
    models: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          catalogKey: { type: 'STRING' },
          officialModelName: { type: 'STRING' },
          inputPer1M: { type: 'NUMBER' },
          outputPer1M: { type: 'NUMBER' },
          cachedPer1M: { type: 'NUMBER' },
          cacheWritePer1M: { type: 'NUMBER' },
          hasContextTiers: { type: 'BOOLEAN' },
          contextThresholdTokens: { type: 'INTEGER' },
          promoValidUntil: { type: 'STRING' },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          evidenceQuote: { type: 'STRING' },
        },
        required: ['officialModelName', 'inputPer1M', 'outputPer1M', 'confidence', 'evidenceQuote'],
      },
    },
  },
  required: ['pageParsedOk', 'models'],
};

function roundRate(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#36;/g, '$')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number.parseInt(n, 10);
      return Number.isFinite(code) && code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
    });
}

/**
 * 将官方 HTML 定价页转换为保留表格边界的结构化纯文本，并在超长时优先保留含价格锚点的窗口。
 */
export function extractCleanPricingText(html, maxChars = MAX_PAGE_CHARS) {
  if (!html || typeof html !== 'string') return '';
  let stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<\/(?:tr|li|p|div|section|article|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  stripped = decodeHtmlEntities(stripped);
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim())
    .filter((line) => line.length > 0);

  const fullText = lines.join('\n');
  if (fullText.length <= maxChars) return fullText;

  // 超长页面按价格锚点行保留上下文窗口，避免尾部模型表被一刀截断
  const anchorRe = /\$|\b(?:mtok|per\s+1m|1m\s+tokens|million\s+tokens|input|output|cached|cache|context|200k|gemini|claude|gpt)\b/i;
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (anchorRe.test(lines[i])) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length - 1, i + 4);
      for (let j = start; j <= end; j++) {
        // 上下文补全行过长时不纳入，避免单行大段落挤占或阻断后续真实价格行
        if (j !== i && lines[j].length > 500) continue;
        keep[j] = 1;
      }
    }
  }

  const chunks = [];
  let total = 0;
  let inGap = false;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      inGap = true;
      continue;
    }
    const remaining = maxChars - total;
    if (remaining <= 32) break;
    let next = lines[i];
    if (next.length + 1 > remaining) {
      if (anchorRe.test(next)) {
        next = next.slice(0, remaining - 1);
      } else {
        inGap = true;
        continue;
      }
    }
    if (inGap && chunks.length > 0 && remaining > 5) {
      chunks.push('...');
      total += 4;
    }
    inGap = false;
    chunks.push(next);
    total += next.length + 1;
  }
  return chunks.join('\n');
}

export function detectBlockedOrEmptyPage(html, cleanText, rule) {
  if (/Just a moment|cf-browser-verification|Enable JavaScript and cookies to continue/i.test(html)) {
    return 'anti_bot_challenge';
  }
  if (cleanText.length < 250) {
    return 'empty_or_csr_shell';
  }
  if (rule && !rule.anchor.test(cleanText)) {
    return 'anchor_missing';
  }
  return null;
}

export function isTrackedCanonicalModel(key, catalog) {
  if (!key || INTERNAL_DERIVATIVE_RE.test(key)) return false;
  const activeSet = new Set(catalog.activeModels ?? []);
  if (activeSet.has(key)) return true;
  const entry = catalog.prices?.[key];
  if (!entry || Array.isArray(entry)) return false;
  return entry.provenance?.verification === 'confirmed';
}

export function resolveCurrentRate(entry, nowMs = Date.now()) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    return (
      entry.find((iv) => {
        const f = iv?.validFrom ? Date.parse(iv.validFrom) : -Infinity;
        const u = iv?.validUntil ? Date.parse(iv.validUntil) : Infinity;
        return nowMs >= f && nowMs < u;
      }) ?? entry[entry.length - 1]
    );
  }
  if (Array.isArray(entry.intervals) && entry.intervals.length > 0) {
    const matched = entry.intervals.find((iv) => {
      const f = iv?.validFrom ? Date.parse(iv.validFrom) : -Infinity;
      const u = iv?.validUntil ? Date.parse(iv.validUntil) : Infinity;
      return nowMs >= f && nowMs < u;
    });
    if (matched) return matched;
  }
  return entry;
}

export function hasPendingFutureInterval(entry, nowMs = Date.now()) {
  const intervals = Array.isArray(entry) ? entry : entry?.intervals;
  if (!Array.isArray(intervals)) return false;
  return intervals.some((iv) => {
    const f = iv?.validFrom ? Date.parse(iv.validFrom) : NaN;
    return Number.isFinite(f) && f > nowMs;
  });
}

function getPendingFutureIntervals(entry, nowMs = Date.now()) {
  const intervals = Array.isArray(entry) ? entry : entry?.intervals;
  if (!Array.isArray(intervals)) return [];
  return intervals.filter((iv) => {
    const f = iv?.validFrom ? Date.parse(iv.validFrom) : NaN;
    return Number.isFinite(f) && f > nowMs;
  });
}

function tupleMatchesRate(rate, inputVal, outputVal, cachedVal, cacheWriteVal) {
  if (!rate) return false;
  if (!ratesClose(rate.input, inputVal) || !ratesClose(rate.output, outputVal)) return false;
  if (Number.isFinite(cachedVal) && !ratesClose(rate.cached, cachedVal)) return false;
  if (rate.cacheWrite !== undefined && Number.isFinite(cacheWriteVal) && !ratesClose(rate.cacheWrite, cacheWriteVal)) {
    return false;
  }
  return true;
}

/**
 * 若本地已预设未来区间且上游出现的差异正好吻合该预设未来区间（同时未出现未预期的其它价格偏离），
 * 说明属于已知且已排期生效的过渡期定价，无需每日重复报黄灯。
 */
export function isAccountedByFutureInterval({ local, entry, officialValid, official, litellm, nowMs = Date.now() }) {
  const futureIntervals = getPendingFutureIntervals(entry, nowMs);
  if (futureIntervals.length === 0) return false;

  return futureIntervals.some((iv) => {
    const officialMatchesLocalOrFuture =
      !officialValid ||
      tupleMatchesRate(local, official.inputPer1M, official.outputPer1M, official.cachedPer1M, official.cacheWritePer1M) ||
      tupleMatchesRate(iv, official.inputPer1M, official.outputPer1M, official.cachedPer1M, official.cacheWritePer1M);

    const litellmMatchesLocalOrFuture =
      !litellm ||
      tupleMatchesRate(local, litellm.input, litellm.output, litellm.cached, litellm.cacheWrite) ||
      tupleMatchesRate(iv, litellm.input, litellm.output, litellm.cached, litellm.cacheWrite);

    return officialMatchesLocalOrFuture && litellmMatchesLocalOrFuture;
  });
}

export function ratesClose(a, b, tolerance = CONSENSUS_TOLERANCE) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= CONSENSUS_ABS_EPSILON) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b), 0.01);
  return diff / denom <= tolerance;
}

export function normalizeUpstreamModelKey(rawKey) {
  return String(rawKey ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(?:vertex_ai|gemini|google|anthropic|openai)\//i, '')
    .replace(/@.+$/, '');
}

export function parseLiteLlmRates(data) {
  const map = new Map();
  const skipProviderOrChannelRe = /(?:^|\/)(?:bedrock|azure|azure_ai|sagemaker|together_ai|fireworks_ai|groq|deepseek|openrouter|databricks|snowflake|cohere|replicate|perplexity|baseten|deepinfra|lambda|cloudflare|mistral|voyage|palm)\b|(?:^|[\/_-])(?:us|eu|europe|asia|ap|me|sa)-(?:central|east|west|north|south|northeast|southeast)|(?:^|[-_/:])(?:batch|flex|priority|provisioned|audio|realtime|image|video|tts|stt|embed)(?:$|[-_/:])/i;
  const directProviderPriority = (key) => {
    if (/^(?:gemini|anthropic|openai)\//i.test(key)) return 3;
    if (!key.includes('/')) return 2;
    if (/^vertex_ai\//i.test(key)) return 1;
    return 0;
  };

  for (const [rawKey, spec] of Object.entries(data ?? {})) {
    if (!spec || typeof spec !== 'object') continue;
    if (skipProviderOrChannelRe.test(rawKey)) continue;
    const priority = directProviderPriority(rawKey);
    if (priority === 0) continue;

    const inPerM = Number(spec.input_cost_per_token) * 1_000_000;
    const outPerM = Number(spec.output_cost_per_token) * 1_000_000;
    if (!Number.isFinite(inPerM) || inPerM <= 0 || !Number.isFinite(outPerM) || outPerM <= 0) continue;

    const cleanKey = normalizeUpstreamModelKey(rawKey);
    if (!cleanKey) continue;

    const cachedRaw = Number(spec.cache_read_input_token_cost);
    const cacheWriteRaw = Number(spec.cache_creation_input_token_cost);
    const hasAbove200k =
      Number.isFinite(Number(spec.input_cost_per_token_above_200k_tokens)) &&
      Number(spec.input_cost_per_token_above_200k_tokens) > 0;

    const candidate = {
      rawKey,
      cleanKey,
      priority,
      input: roundRate(inPerM),
      output: roundRate(outPerM),
      ...(Number.isFinite(cachedRaw) && cachedRaw >= 0 ? { cached: roundRate(cachedRaw * 1_000_000) } : {}),
      ...(Number.isFinite(cacheWriteRaw) && cacheWriteRaw >= 0 ? { cacheWrite: roundRate(cacheWriteRaw * 1_000_000) } : {}),
      hasContextTiers: hasAbove200k,
      source: 'litellm',
    };

    const existing = map.get(cleanKey);
    if (!existing || candidate.priority > existing.priority) {
      map.set(cleanKey, candidate);
    }
  }
  return map;
}

export function parseOpenRouterRates(payload) {
  const map = new Map();
  for (const item of payload?.data ?? []) {
    const id = normalizeUpstreamModelKey(item?.id ?? '');
    if (!id || IGNORED_RADAR_SUFFIX_RE.test(id)) continue;
    const inPerM = Number(item?.pricing?.prompt) * 1_000_000;
    const outPerM = Number(item?.pricing?.completion) * 1_000_000;
    if (!Number.isFinite(inPerM) || inPerM <= 0 || !Number.isFinite(outPerM) || outPerM <= 0) continue;
    const cacheReadRaw = Number(item?.pricing?.input_cache_read);
    const cacheWriteRaw = Number(item?.pricing?.input_cache_write);
    map.set(id, {
      cleanKey: id,
      input: roundRate(inPerM),
      output: roundRate(outPerM),
      ...(Number.isFinite(cacheReadRaw) && cacheReadRaw >= 0 ? { cached: roundRate(cacheReadRaw * 1_000_000) } : {}),
      ...(Number.isFinite(cacheWriteRaw) && cacheWriteRaw >= 0 ? { cacheWrite: roundRate(cacheWriteRaw * 1_000_000) } : {}),
      source: 'openrouter',
    });
  }
  return map;
}

function lookupUpstreamForCatalogKey(key, map) {
  const candidates = [key, ...(CATALOG_TO_UPSTREAM_ALIASES[key] ?? [])].map((s) => s.toLowerCase());
  for (const candidate of candidates) {
    if (map.has(candidate)) return map.get(candidate);
  }
  return null;
}

export async function extractPricesWithGemini({ url, vendor, cleanText, targetModels, apiKey, model = process.env.GEMINI_MODEL || 'gemini-4-hydrogen', fetchImpl = fetch }) {
  const modelListText = targetModels
    .map((m) => `- catalogKey: "${m.key}", displayName: "${m.displayName}"`)
    .join('\n');

  const prompt = [
    `You are auditing official LLM API pricing from ${vendor} (${url}).`,
    'Extract ONLY standard pay-as-you-go Global/Standard API text token pricing in USD per 1M tokens.',
    'Ignore Batch API, Provisioned Throughput, regional premiums, audio/image/video modalities, and deprecated models unless listed below.',
    'If a model has >200k long-context tiered pricing, record the base (<=200k) rates in inputPer1M/outputPer1M/cachedPer1M and set hasContextTiers=true and contextThresholdTokens=200000.',
    'Also extract any NEW flagship chat models on this page that are not in the target list below (leave catalogKey empty for genuinely new models).',
    'For each extracted model, include a short verbatim quote from the page in evidenceQuote (<= 160 chars). Never guess missing numbers.',
    '',
    'Target catalog models to look for on this page:',
    modelListText || '(none)',
    '',
    'Cleaned pricing page text:',
    cleanText,
  ].join('\n');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_EXTRACTION_SCHEMA,
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Gemini API HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (res.status === 429 || res.status >= 500) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
      const payload = await res.json();
      const rawJsonText = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!rawJsonText) throw new Error('Gemini API returned empty content');
      const parsed = JSON.parse(rawJsonText);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models)) {
        throw new Error('Gemini API JSON missing models array');
      }
      return parsed;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('Gemini API extraction failed');
}

/**
 * 对单个模型评估本地价格 vs 官网提取 vs LiteLLM 共识门禁，返回：
 * - status: 'unchanged' | 'green' | 'yellow'
 */
export function evaluateModelConsensus({
  key,
  localEntry,
  official,
  litellm,
  openrouter,
  nowMs = Date.now(),
}) {
  const local = resolveCurrentRate(localEntry, nowMs);
  if (!local) return { key, status: 'unchanged' };

  const officialValid =
    official &&
    official.confidence !== 'low' &&
    Number.isFinite(official.inputPer1M) &&
    official.inputPer1M > 0 &&
    Number.isFinite(official.outputPer1M) &&
    official.outputPer1M > 0;

  const officialDiffers =
    officialValid &&
    (!ratesClose(local.input, official.inputPer1M) ||
      !ratesClose(local.output, official.outputPer1M) ||
      (Number.isFinite(official.cachedPer1M) && !ratesClose(local.cached, official.cachedPer1M)) ||
      (local.cacheWrite !== undefined &&
        Number.isFinite(official.cacheWritePer1M) &&
        !ratesClose(local.cacheWrite, official.cacheWritePer1M)));

  const litellmDiffers =
    litellm &&
    (!ratesClose(local.input, litellm.input) ||
      !ratesClose(local.output, litellm.output) ||
      (Number.isFinite(litellm.cached) && !ratesClose(local.cached, litellm.cached)) ||
      (local.cacheWrite !== undefined &&
        Number.isFinite(litellm.cacheWrite) &&
        !ratesClose(local.cacheWrite, litellm.cacheWrite)));

  if (!officialDiffers && !litellmDiffers) {
    return { key, status: 'unchanged', local, official, litellm, openrouter };
  }

  if (isAccountedByFutureInterval({ local, entry: localEntry, officialValid, official, litellm, nowMs })) {
    return { key, status: 'unchanged', local, official, litellm, openrouter };
  }

  const reasons = [];
  if (!officialValid) reasons.push('官网未抓到高/中置信度有效价格（仅 LiteLLM 存在偏移）');
  if (!litellm) reasons.push('LiteLLM 缺少对应通道报价（孤证）');

  if (officialValid && litellm) {
    if (!ratesClose(official.inputPer1M, litellm.input) || !ratesClose(official.outputPer1M, litellm.output)) {
      reasons.push(`官网($${official.inputPer1M}/$${official.outputPer1M})与LiteLLM($${litellm.input}/$${litellm.output})偏差>1%`);
    }
    const offCached = Number.isFinite(official.cachedPer1M) ? official.cachedPer1M : null;
    const ltCached = Number.isFinite(litellm.cached) ? litellm.cached : null;
    if (offCached !== null && ltCached !== null && !ratesClose(offCached, ltCached)) {
      reasons.push(`官网cached($${offCached})与LiteLLM($${ltCached})偏差>1%`);
    } else if (offCached === null && ltCached !== null && !ratesClose(local.cached, ltCached)) {
      reasons.push('官网缺少cached报价无法交叉印证');
    } else if (offCached !== null && ltCached === null && !ratesClose(local.cached, offCached)) {
      reasons.push('LiteLLM缺少cached报价无法交叉印证');
    }

    if (local.cacheWrite !== undefined && local.cacheWrite > 0) {
      const offCw = Number.isFinite(official.cacheWritePer1M) ? official.cacheWritePer1M : null;
      const ltCw = Number.isFinite(litellm.cacheWrite) ? litellm.cacheWrite : null;
      if (offCw === null || ltCw === null || !ratesClose(offCw, ltCw)) {
        reasons.push('本地已配置cacheWrite但双源未能一致印证');
      }
    }
  }

  if (officialValid) {
    const inRatio = official.inputPer1M / Math.max(0.0001, local.input);
    const outRatio = official.outputPer1M / Math.max(0.0001, local.output);
    if (
      inRatio < MIN_PRICE_RATIO ||
      inRatio > MAX_PRICE_RATIO ||
      outRatio < MIN_PRICE_RATIO ||
      outRatio > MAX_PRICE_RATIO
    ) {
      reasons.push(`价格波动比例(${inRatio.toFixed(2)}x / ${outRatio.toFixed(2)}x)超出0.2x~3.0x安全阈值`);
    }
    if (
      official.inputPer1M > MAX_SAFE_USD_PER_M ||
      official.outputPer1M > MAX_SAFE_USD_PER_M ||
      (Number.isFinite(official.cachedPer1M) && official.cachedPer1M > MAX_SAFE_USD_PER_M)
    ) {
      reasons.push(`提取单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`);
    }

    const localHasTiers = Array.isArray(local.contextTiers) && local.contextTiers.length > 0;
    if (Boolean(official.hasContextTiers) !== localHasTiers) {
      reasons.push('contextTiers阶梯结构与本地不一致');
    }
    if (official.promoValidUntil) {
      const existingUntil = local.validUntil ?? local.provenance?.validUntil ?? '';
      if (!existingUntil || !existingUntil.startsWith(official.promoValidUntil.slice(0, 10))) {
        reasons.push(`检测到促销截止日(${official.promoValidUntil})变动`);
      }
    }
  }

  if (hasPendingFutureInterval(localEntry, nowMs)) {
    reasons.push('本地已配置未来生效区间，拒绝自动覆盖');
  }

  if (reasons.length > 0) {
    return {
      key,
      status: 'yellow',
      reasons,
      local,
      official: officialValid ? official : null,
      litellm,
      openrouter,
    };
  }

  const nextCached = Number.isFinite(official.cachedPer1M)
    ? roundRate(official.cachedPer1M)
    : Number.isFinite(litellm.cached)
      ? roundRate(litellm.cached)
      : local.cached;

  const nextCacheWrite =
    local.cacheWrite !== undefined
      ? Number.isFinite(official.cacheWritePer1M)
        ? roundRate(official.cacheWritePer1M)
        : local.cacheWrite
      : Number.isFinite(official.cacheWritePer1M) && Number.isFinite(litellm.cacheWrite) && ratesClose(official.cacheWritePer1M, litellm.cacheWrite)
        ? roundRate(official.cacheWritePer1M)
        : undefined;

  return {
    key,
    status: 'green',
    local,
    official,
    litellm,
    openrouter,
    proposed: {
      input: roundRate(official.inputPer1M),
      output: roundRate(official.outputPer1M),
      cached: nextCached,
      ...(nextCacheWrite !== undefined ? { cacheWrite: nextCacheWrite } : {}),
      ...(Array.isArray(local.contextTiers) ? { contextTiers: local.contextTiers } : {}),
    },
  };
}

export function bumpCatalogVersion(currentVersion, todayDate) {
  const ver = String(currentVersion ?? '').trim();
  if (!ver || ver < todayDate) return todayDate;
  if (ver === todayDate) return `${todayDate}-r2`;
  const m = ver.match(new RegExp(`^${todayDate}-r(\\d+)$`));
  if (m) return `${todayDate}-r${Number.parseInt(m[1], 10) + 1}`;
  if (ver.startsWith(todayDate)) return `${todayDate}-r2`;
  return todayDate;
}

/**
 * 以不篡改历史的方式安全增量更新 catalog.prices[key] 与顶层版本元数据。
 */
export function applyVerifiedPriceUpdate(catalog, key, proposed, nowMs = Date.now(), options = {}) {
  const { bumpVersion = true } = options;
  const entry = catalog.prices?.[key];
  if (!entry || Array.isArray(entry)) {
    throw new Error(`无法更新非标准对象条目: ${key}`);
  }

  const todayDate = new Date(nowMs).toISOString().slice(0, 10);
  const todayStartIso = `${todayDate}T00:00:00Z`;
  const yesterdayEndIso = new Date(Date.parse(todayStartIso) - 1000).toISOString().replace('.000Z', 'Z');
  const currentActive = resolveCurrentRate(entry, nowMs);
  const baseProv = currentActive?.provenance ?? entry.provenance ?? {};

  const newProv = {
    ...(baseProv.sourceUrl ? { sourceUrl: baseProv.sourceUrl } : {}),
    ...(baseProv.platform ? { platform: baseProv.platform } : {}),
    ...(baseProv.platformEn ? { platformEn: baseProv.platformEn } : {}),
    conditions: `标准全量定价（${todayDate}生效）`,
    conditionsEn: `Standard list pricing (effective ${todayDate})`,
    checkedAt: todayDate,
    validFrom: todayStartIso,
    validUntil: null,
    verification: 'confirmed',
  };

  if (!Array.isArray(entry.intervals) || entry.intervals.length === 0) {
    const oldProv = {
      ...baseProv,
      validUntil: yesterdayEndIso,
    };
    entry.intervals = [
      {
        model: key,
        validFrom: baseProv.validFrom ?? null,
        validUntil: yesterdayEndIso,
        input: entry.input,
        output: entry.output,
        cached: entry.cached,
        ...(entry.cacheWrite !== undefined ? { cacheWrite: entry.cacheWrite } : {}),
        ...(Array.isArray(entry.contextTiers) ? { contextTiers: entry.contextTiers } : {}),
        provenance: oldProv,
      },
      {
        model: key,
        validFrom: todayStartIso,
        validUntil: null,
        input: proposed.input,
        output: proposed.output,
        cached: proposed.cached,
        ...(proposed.cacheWrite !== undefined ? { cacheWrite: proposed.cacheWrite } : {}),
        ...(Array.isArray(proposed.contextTiers) ? { contextTiers: proposed.contextTiers } : {}),
        provenance: { ...newProv },
      },
    ];
  } else {
    const activeIdx = entry.intervals.findIndex((iv) => {
      const f = iv?.validFrom ? Date.parse(iv.validFrom) : -Infinity;
      const u = iv?.validUntil ? Date.parse(iv.validUntil) : Infinity;
      return nowMs >= f && nowMs < u;
    });
    const targetIdx = activeIdx >= 0 ? activeIdx : entry.intervals.length - 1;
    const activeIv = entry.intervals[targetIdx];

    if (activeIv.validFrom === todayStartIso && !activeIv.validUntil) {
      activeIv.input = proposed.input;
      activeIv.output = proposed.output;
      activeIv.cached = proposed.cached;
      if (proposed.cacheWrite !== undefined) activeIv.cacheWrite = proposed.cacheWrite;
      if (Array.isArray(proposed.contextTiers)) activeIv.contextTiers = proposed.contextTiers;
      activeIv.provenance = { ...newProv };
    } else {
      activeIv.validUntil = yesterdayEndIso;
      activeIv.provenance = { ...(activeIv.provenance ?? baseProv), validUntil: yesterdayEndIso };
      entry.intervals.push({
        model: key,
        validFrom: todayStartIso,
        validUntil: null,
        input: proposed.input,
        output: proposed.output,
        cached: proposed.cached,
        ...(proposed.cacheWrite !== undefined ? { cacheWrite: proposed.cacheWrite } : {}),
        ...(Array.isArray(proposed.contextTiers) ? { contextTiers: proposed.contextTiers } : {}),
        provenance: { ...newProv },
      });
    }
  }

  // 同步顶层当前有效基准字段（供直接读取 DEFAULT_API_PRICES[key] 顶层属性的模块与测试使用）
  entry.input = proposed.input;
  entry.output = proposed.output;
  entry.cached = proposed.cached;
  if (proposed.cacheWrite !== undefined) entry.cacheWrite = proposed.cacheWrite;
  if (Array.isArray(proposed.contextTiers)) entry.contextTiers = proposed.contextTiers;
  entry.provenance = { ...newProv };

  if (bumpVersion) {
    catalog.pricingVersion = bumpCatalogVersion(catalog.pricingVersion, todayDate);
    catalog.pricingUpdatedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

function collectExpiringIntervals(catalog, nowMs = Date.now()) {
  const expiring = [];
  for (const [key, entry] of Object.entries(catalog.prices ?? {})) {
    const items = Array.isArray(entry) ? entry : [entry, ...(entry.intervals ?? [])];
    for (const item of items) {
      const validUntil = item?.validUntil ?? item?.provenance?.validUntil;
      if (!validUntil) continue;
      const untilMs = Date.parse(validUntil);
      if (!Number.isFinite(untilMs)) continue;
      const hasSuccessor =
        Array.isArray(entry?.intervals) &&
        entry.intervals.some((iv) => {
          const fromMs = iv?.validFrom ? Date.parse(iv.validFrom) : NaN;
          return Number.isFinite(fromMs) && fromMs >= untilMs - 1000 && !iv.validUntil;
        });
      if (!hasSuccessor && untilMs - nowMs <= WARN_HORIZON_MS) {
        expiring.push({ key, validUntil });
      }
    }
  }
  return expiring;
}

function formatPriceTuple(rate) {
  if (!rate) return '—';
  const inVal = rate.input ?? rate.inputPer1M;
  const outVal = rate.output ?? rate.outputPer1M;
  const cachedVal = rate.cached ?? rate.cachedPer1M;
  const cwVal = rate.cacheWrite ?? rate.cacheWritePer1M;
  const parts = [`$${inVal} / $${outVal}`];
  if (Number.isFinite(cachedVal)) parts.push(`c:$${cachedVal}`);
  if (Number.isFinite(cwVal) && cwVal > 0) parts.push(`cw:$${cwVal}`);
  return parts.join(' ');
}

export async function runAutoUpdatePricing(options = {}) {
  const writeMode = Boolean(options.write);
  const nowMs = options.nowMs ?? Date.now();
  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH;
  const feedPath = options.feedPath ?? DEFAULT_FEED_PATH;
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const fetchImpl = options.fetchImpl ?? fetch;
  const geminiApiKey = options.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';

  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const trackedKeys = Object.keys(catalog.prices ?? {}).filter((k) => isTrackedCanonicalModel(k, catalog));

  // 1. 收集去重官方 sourceUrl 及对应需要追踪的模型
  const sourceTargets = new Map();
  for (const key of trackedKeys) {
    const current = resolveCurrentRate(catalog.prices[key], nowMs);
    const url = current?.provenance?.sourceUrl ?? catalog.prices[key]?.provenance?.sourceUrl;
    if (typeof url !== 'string' || !url.startsWith('https://')) continue;
    if (!sourceTargets.has(url)) sourceTargets.set(url, []);
    sourceTargets.get(url).push({ key, displayName: catalog.names?.[key] ?? key });
  }

  // 2. 抓取官网定价页 + 调用 Gemini Flash 结构化提取
  const probeRows = [];
  const pageAlerts = [];
  const officialByKey = new Map();
  const discoveredOfficialNewModels = [];
  const knownAliasSet = new Set([
    ...Object.keys(catalog.prices ?? {}).map((k) => k.toLowerCase()),
    ...Object.keys(catalog.aliases ?? {}).map((k) => k.toLowerCase()),
  ]);

  for (const [url, targetModels] of sourceTargets.entries()) {
    const rule = VENDOR_CONTENT_ANCHORS.find((r) => r.match.test(url));
    const vendor = rule?.vendor ?? 'Upstream';
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'GravityBox-PricingWatch/1.2 (+https://github.com/Enzoo404/gravitybox)',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(20_000),
      });
      const html = res.ok ? await res.text() : '';
      const cleanText = res.ok ? extractCleanPricingText(html) : '';
      const blockReason = res.ok ? detectBlockedOrEmptyPage(html, cleanText, rule) : `http_${res.status}`;

      if (blockReason) {
        pageAlerts.push(`[${vendor}] ${blockReason}: ${url}`);
        probeRows.push(`| ${vendor} | \`${res.status}\` | ${blockReason} | ${url} |`);
        continue;
      }

      if (!geminiApiKey) {
        probeRows.push(`| ${vendor} | \`${res.status}\` | Anchored (No Gemini Key) | ${url} |`);
        continue;
      }

      const extracted = await extractPricesWithGemini({
        url,
        vendor,
        cleanText,
        targetModels,
        apiKey: geminiApiKey,
        fetchImpl,
      });

      if (!extracted.pageParsedOk) {
        pageAlerts.push(`[${vendor}] gemini_parse_unconfirmed: ${url}`);
        probeRows.push(`| ${vendor} | \`${res.status}\` | Parse Low Confidence | ${url} |`);
        continue;
      }

      probeRows.push(`| ${vendor} | \`${res.status}\` | Parsed (${extracted.models.length} models) | ${url} |`);

      for (const item of extracted.models) {
        const matchedKey =
          (item.catalogKey && catalog.prices?.[item.catalogKey] ? item.catalogKey : null) ??
          targetModels.find(
            (m) =>
              m.key.toLowerCase() === String(item.officialModelName ?? '').trim().toLowerCase() ||
              m.displayName.toLowerCase() === String(item.officialModelName ?? '').trim().toLowerCase()
          )?.key ??
          null;

        if (matchedKey) {
          officialByKey.set(matchedKey, item);
        } else {
          const normName = normalizeUpstreamModelKey(item.officialModelName);
          if (normName && MODERN_RADAR_MODEL_RE.test(normName) && !IGNORED_RADAR_SUFFIX_RE.test(normName) && !knownAliasSet.has(normName)) {
            discoveredOfficialNewModels.push({ vendor, url, item });
          }
        }
      }
    } catch (err) {
      const reason = err?.message ?? String(err);
      pageAlerts.push(`[${vendor}] ${reason}: ${url}`);
      probeRows.push(`| ${vendor} | \`ERR\` | ${reason.slice(0, 48)} | ${url} |`);
    }
  }

  // 3. 拉取 LiteLLM 与 OpenRouter 结构化价格表
  let litellmMap = new Map();
  try {
    const res = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(12_000) });
    if (res.ok) litellmMap = parseLiteLlmRates(await res.json());
  } catch (err) {
    pageAlerts.push(`[LiteLLM] unreachable: ${err?.message ?? err}`);
  }

  let openrouterMap = new Map();
  try {
    const res = await fetchImpl(OPENROUTER_URL, { signal: AbortSignal.timeout(12_000) });
    if (res.ok) openrouterMap = parseOpenRouterRates(await res.json());
  } catch (err) {
    pageAlerts.push(`[OpenRouter] unreachable: ${err?.message ?? err}`);
  }

  // 4. 共识门禁逐一评估
  const greenUpdates = [];
  const yellowItems = [];
  for (const key of trackedKeys) {
    const evaluation = evaluateModelConsensus({
      key,
      localEntry: catalog.prices[key],
      official: officialByKey.get(key) ?? null,
      litellm: lookupUpstreamForCatalogKey(key, litellmMap),
      openrouter: lookupUpstreamForCatalogKey(key, openrouterMap),
      nowMs,
    });
    if (evaluation.status === 'green') greenUpdates.push(evaluation);
    else if (evaluation.status === 'yellow') yellowItems.push(evaluation);
  }

  // 新模型雷达（仅关注现代主流对话模型，避免数百个历史旧模型刷屏）
  const newModelsRadar = [];
  for (const entry of discoveredOfficialNewModels) {
    const id = normalizeUpstreamModelKey(entry.item.officialModelName);
    newModelsRadar.push({
      model: id,
      official: entry.item,
      litellm: litellmMap.get(id) ?? null,
      openrouter: openrouterMap.get(id) ?? null,
      note: '官网发现未入库现代模型（需人工确认是否加入 activeModels 并同步单测）',
    });
  }

  const expiring = collectExpiringIntervals(catalog, nowMs);

  // 5. 执行增量写入（仅应用经过双源共识的 greenUpdates）
  let filesModified = false;
  if (writeMode && greenUpdates.length > 0) {
    const todayDate = new Date(nowMs).toISOString().slice(0, 10);
    for (const item of greenUpdates) {
      applyVerifiedPriceUpdate(catalog, item.key, item.proposed, nowMs, { bumpVersion: false });
    }
    catalog.pricingVersion = bumpCatalogVersion(catalog.pricingVersion, todayDate);
    catalog.pricingUpdatedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    const feed = buildPricingFeed(catalog);
    await writeFile(feedPath, JSON.stringify(feed, null, 2) + '\n', 'utf8');
    filesModified = true;
  }

  // 6. 决策分流：no_change / green_auto_merge / yellow_needs_review
  // 注：newModelsRadar 仅作信息雷达展示，不阻断已入库模型经过双源共识核实的自动合入
  let decision = 'no_change';
  if (yellowItems.length > 0 || expiring.length > 0) {
    decision = 'yellow_needs_review';
  } else if (greenUpdates.length > 0) {
    decision = 'green_auto_merge';
  }

  const reviewRows = [...yellowItems, ...newModelsRadar.map((n) => ({ ...n, key: n.model, local: null, reasons: [n.note] }))].map(
    (item) => {
      const quote = item.official?.evidenceQuote ? ` (${String(item.official.evidenceQuote).replace(/\|/g, '/').slice(0, 80)})` : '';
      return `| \`${item.key}\` | ${formatPriceTuple(item.local)} | ${formatPriceTuple(item.official)}${quote} | ${formatPriceTuple(item.litellm)} | ${formatPriceTuple(item.openrouter)} |`;
    }
  );

  const summaryLines = [
    '### Pricing Watch Auto-Audit Summary',
    '',
    `- **Decision**: \`${decision}\``,
    `- **Gemini Flash Extraction**: ${geminiApiKey ? 'enabled' : 'skipped (GEMINI_API_KEY not set)'}`,
    `- **Verified Consensus Updates (Green)**: ${greenUpdates.length}`,
    `- **Needs Review / Divergence / New Models (Yellow)**: ${yellowItems.length + newModelsRadar.length}`,
    `- **Expiring Promotional Intervals (<=14d)**: ${expiring.length}`,
    '',
    '| Vendor | HTTP | Status | Source URL |',
    '| :--- | :--- | :--- | :--- |',
    ...probeRows,
    '',
    ...(greenUpdates.length > 0
      ? [
          '#### Verified Consensus Updates Applied',
          '',
          '| Model | Old Rate | New Rate (Verified) | Evidence |',
          '| :--- | :--- | :--- | :--- |',
          ...greenUpdates.map(
            (g) =>
              `| \`${g.key}\` | ${formatPriceTuple(g.local)} | ${formatPriceTuple(g.proposed)} | ${String(g.official?.evidenceQuote ?? '').replace(/\|/g, '/').slice(0, 100)} |`
          ),
          '',
        ]
      : []),
    ...(reviewRows.length > 0
      ? [
          '#### Needs-Review Comparison (4-Source Matrix)',
          '',
          '| Model | Local | Official (+Quote) | LiteLLM | OpenRouter |',
          '| :--- | :--- | :--- | :--- | :--- |',
          ...reviewRows,
          '',
          ...yellowItems.map((y) => `- **\`${y.key}\`**: ${y.reasons.join('；')}`),
          ...newModelsRadar.map((n) => `- **\`${n.model}\`** (新模型): ${n.note}`),
          '',
        ]
      : []),
    ...(expiring.length > 0
      ? [
          '#### Expiring Promotional Intervals',
          '',
          ...expiring.map((e) => `- \`${e.key}\`: validUntil \`${e.validUntil}\``),
          '',
        ]
      : []),
  ];

  const report = {
    decision,
    filesModified,
    geminiEnabled: Boolean(geminiApiKey),
    greenUpdates,
    yellowItems,
    newModelsRadar,
    expiring,
    pageAlerts,
    summaryMarkdown: summaryLines.join('\n'),
  };

  if (reportPath) {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const report = await runAutoUpdatePricing({ write });
  console.log(report.summaryMarkdown);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    const lines = [
      `decision=${report.decision}`,
      `files_modified=${report.filesModified ? 'true' : 'false'}`,
      `has_alert=${report.decision === 'yellow_needs_review' ? 'true' : 'false'}`,
      `green_count=${report.greenUpdates.length}`,
      `yellow_count=${report.yellowItems.length + report.newModelsRadar.length}`,
    ];
    await appendFile(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n', 'utf8');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report.summaryMarkdown + '\n', 'utf8');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack ?? err?.message ?? String(err));
    process.exitCode = 1;
  });
}
