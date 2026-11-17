import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStatsManager } from '../dist/usage.js';
import { UsageLedger } from '../dist/usage-ledger.js';
import {
  classifyUsageWarningCode,
  buildPricingWarningCodes,
  buildUsageSummaryReport,
} from '../dist/usage-report.js';
import {
  isUnpricedZeroSentinel,
  calculateLockedEventUsd,
  formatLocalDate,
} from '../dist/usage-aggregate.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';
import { setActiveLocale, getActiveLocale } from '../dist/i18n.js';

async function withFixture(t, fn) {
  const root = await mkdtemp(join(tmpdir(), 'gb-usage-fixes-'));
  const stateDir = join(root, 'state');
  const geminiDir = join(root, 'gemini');
  const convDir = join(geminiDir, 'antigravity', 'conversations');
  await mkdir(stateDir, { recursive: true });
  await mkdir(convDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return fn({ root, stateDir, geminiDir, convDir });
}

test('P0-04: pricing_warning_codes 中英文 1:1 并行输出且 receipts_unmatched 不污染实例 storageWarnings', async t => {
  assert.equal(classifyUsageWarningCode('旧JSON含缺少来源或归属证据的记录，已加入人工复核列表'), 'legacy_json_migrated');
  assert.equal(classifyUsageWarningCode('Legacy JSON contains entries without verified sources'), 'legacy_json_migrated');
  assert.equal(classifyUsageWarningCode('旧账本含费用反推记录，已标记待核对'), 'legacy_ledger_migrated');
  assert.equal(classifyUsageWarningCode('Legacy ledger contains synthetic receipts'), 'legacy_ledger_migrated');
  assert.equal(classifyUsageWarningCode('历史金额凭据缺少原始用量或时间，未计入汇总'), 'historical_receipts_locked');
  assert.equal(classifyUsageWarningCode('Historical cost receipts lack raw token counts or timestamps'), 'historical_receipts_locked');
  assert.equal(classifyUsageWarningCode('其他自定义提醒'), 'warning');
  assert.deepEqual(
    buildPricingWarningCodes([
      'Legacy JSON item',
      'Legacy ledger item',
      'Historical cost receipts item',
      'other',
    ]),
    ['legacy_json_migrated', 'legacy_ledger_migrated', 'historical_receipts_locked', 'warning']
  );

  const prevLocale = getActiveLocale();
  t.after(() => setActiveLocale(prevLocale));

  await withFixture(t, async ({ stateDir, geminiDir }) => {
    await writeFile(
      join(stateDir, 'usage-rate-locks.json'),
      JSON.stringify({
        version: 1,
        profiles: [{ model: 'gemini-4-carbon', input: 2, output: 10, cached: 0.1 }],
        entries: { ['a'.repeat(64)]: { usd: 0.05, p: 0 } },
      })
    );

    for (const locale of ['zh-Hans', 'en']) {
      setActiveLocale(locale);
      const manager = new UsageStatsManager({ stateDir, geminiDir });
      const summary = await manager.getUsageSummary(true);
      assert.ok(Array.isArray(summary.pricing_warning_codes));
      assert.equal(summary.pricing_warning_codes.length, summary.pricing_warnings.length);
      assert.ok(summary.pricing_warning_codes.includes('historical_receipts_locked'));
    }

    // 同一实例先遇未匹配凭据，再在后续扫描中补齐对应事件时，实例 storageWarnings 不得残留上轮 receipts_unmatched
    const manager = new UsageStatsManager({ stateDir, geminiDir });
    let includeReceiptEvent = false;
    manager.discoverDatabaseFiles = async () => ['synthetic-receipt.db'];
    manager.scanDatabaseEvents = async () => ({
      events: includeReceiptEvent
        ? [
            {
              event_key: 'a'.repeat(64),
              source_id: 'src-receipt',
              model: 'gemini-4-carbon',
              input_tokens: 100,
              output_tokens: 10,
              cached_tokens: 0,
              total_tokens: 110,
              timestamp_seconds: Math.floor(Date.now() / 1000) - 30,
            },
          ]
        : [],
      generationsScanned: includeReceiptEvent ? 1 : 0,
      skippedLargeRecords: 0,
    });
    const withReceipt = await manager.getUsageSummary(true);
    assert.ok(withReceipt.pricing_warning_codes.includes('historical_receipts_locked'));

    includeReceiptEvent = true;
    const afterMatched = await manager.getUsageSummary(true);
    assert.equal(afterMatched.pricing_warning_codes.includes('historical_receipts_locked'), false);
    assert.equal(afterMatched.availability, 'complete');
  });
});

test('P0-10 & P0-11: zero-sentinel 与缺失 cacheWrite 锁在 lockedCost 与 ledgerEventPage 中统一标记未计价且不抛错', async t => {
  assert.equal(isUnpricedZeroSentinel({ model: 'legacy', input: 0, output: 0, cached: 0 }), true);
  assert.equal(isUnpricedZeroSentinel({ model: 'legacy', input: 0, output: 0, cached: 0, cacheWrite: 0 }), true);
  assert.equal(
    isUnpricedZeroSentinel({ model: 'free', input: 0, output: 0, cached: 0, provenance: { verification: 'confirmed' } }),
    false
  );
  assert.equal(isUnpricedZeroSentinel({ model: 'paid', input: 0, output: 1, cached: 0 }), false);

  assert.equal(
    calculateLockedEventUsd(
      { input_tokens: 1000, output_tokens: 500, cached_tokens: 200, cache_write_tokens: 100 },
      { model: 'm', input: 1, output: 2, cached: 0.1 }
    ),
    null
  );
  assert.equal(
    calculateLockedEventUsd(
      { input_tokens: 1000, output_tokens: 500, cached_tokens: 200, cache_write_tokens: 0 },
      { model: 'm', input: 0, output: 0, cached: 0 }
    ),
    null
  );
  const tieredLockedUsd = calculateLockedEventUsd(
    { input_tokens: 150_000, output_tokens: 0, cached_tokens: 60_000, cache_write_tokens: 0 },
    {
      model: 'tier',
      input: 1,
      output: 2,
      cached: 0.1,
      contextTiers: [{ thresholdTokens: 200_000, input: 3, output: 6, cached: 0.3 }],
    }
  );
  assert.ok(Math.abs(tieredLockedUsd - 0.468) < 1e-12);

  await withFixture(t, async ({ stateDir, geminiDir }) => {
    const now = Math.floor(Date.now() / 1000);
    const kZero = '1'.repeat(64);
    const kNoCw = '2'.repeat(64);

    // 1. 小账本 lockedCost：跳过 zero-sentinel 锁，且在实时费率也无 cacheWrite 时返回 null 而不抛错
    await writeFile(
      join(stateDir, 'usage-rate-locks.json'),
      JSON.stringify({
        version: 1,
        profiles: [
          { model: 'gemini-2.5-flash', input: 0, output: 0, cached: 0 },
          { model: 'custom-no-cw', input: 1, output: 2, cached: 0.1 },
        ],
        entries: {
          [kZero]: { usd: 0, p: 0 },
          [kNoCw]: { usd: 0.5, p: 1 },
        },
      })
    );

    const manager = new UsageStatsManager({ stateDir, geminiDir });
    await manager.savePricingTable({
      'custom-no-cw': { model: 'custom-no-cw', input: 1, output: 2, cached: 0.1 },
    });
    manager.discoverDatabaseFiles = async () => ['synthetic.db'];
    manager.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: kZero,
          source_id: 'src-1',
          model: 'gemini-2.5-flash',
          input_tokens: 1_000_000,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 1_000_000,
          timestamp_seconds: now - 60,
        },
        {
          event_key: kNoCw,
          source_id: 'src-2',
          model: 'custom-no-cw',
          input_tokens: 1000,
          output_tokens: 100,
          cached_tokens: 0,
          cache_write_tokens: 500,
          total_tokens: 1600,
          timestamp_seconds: now - 30,
        },
      ],
      generationsScanned: 2,
      skippedLargeRecords: 0,
    });

    const summary = await manager.getUsageSummary(true);
    const flashStat = summary.all_time.by_model.find(m => m.model === 'gemini-2.5-flash');
    const noCwStat = summary.all_time.by_model.find(m => m.model === 'custom-no-cw');
    assert.ok(flashStat && flashStat.priced === true && flashStat.estimated_usd > 0, 'zero-sentinel 锁应被跳过并改用真实实时费率');
    assert.ok(noCwStat && noCwStat.priced === false && noCwStat.estimated_usd === 0, '缺少 cacheWrite 时不应使用缺字段旧锁或抛错');

    // 2. Worker / ledgerEventPage 口径一致性：zero-sentinel 与缺 cacheWrite 锁返回 estimated_usd: null, priced: false
    const ledger = new UsageLedger(join(stateDir, 'isolated-ledger'));
    const evZero = {
      event_key: '3'.repeat(64),
      source_id: 'src-3',
      model: 'unpriced-legacy-zero',
      input_tokens: 1000,
      output_tokens: 500,
      cached_tokens: 0,
      total_tokens: 1500,
      timestamp_seconds: now - 20,
    };
    const evNoCw = {
      event_key: '4'.repeat(64),
      source_id: 'src-4',
      model: 'unpriced-legacy-nocw',
      input_tokens: 1000,
      output_tokens: 500,
      cached_tokens: 0,
      cache_write_tokens: 100,
      total_tokens: 1600,
      timestamp_seconds: now - 10,
    };
    await ledger.save([evZero, evNoCw]);
    await ledger.saveLocks({
      [evZero.event_key]: { usd: 0, price: { model: 'unpriced-legacy-zero', input: 0, output: 0, cached: 0 } },
      [evNoCw.event_key]: { usd: 0.5, price: { model: 'unpriced-legacy-nocw', input: 1, output: 2, cached: 0.1 } },
    });

    const agg = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(agg.all_time.estimated_usd, 0);
    assert.ok(agg.all_time.by_model.every(m => m.priced === false));

    const page = await ledger.events({
      snapshot: agg.ledger_snapshot,
      period: 'all',
      query: '',
      offset: 0,
      limit: 10,
    });
    assert.equal(page.total, 2);
    for (const row of page.rows) {
      assert.equal(row.estimated_usd, null);
      assert.equal(row.priced, false);
    }
  });
});

test('P1-08 & P1-13: 未来偏移时间不污染日趋势、buildUsageSummaryReport 空有效集合按 allEvents 判可用性、失败缓存跨午夜失效', async t => {
  const fixedNoon = new Date(2026, 10, 15, 12, 0, 0, 0);
  const now = Math.floor(fixedNoon.getTime() / 1000);
  const tomorrowStart = Math.floor(new Date(2026, 10, 16, 0, 0, 0, 0).getTime() / 1000);
  const todayStr = formatLocalDate(fixedNoon);

  // 1. buildUsageSummaryReport: future event 保留在 all_time，但不进入 daily_trends 或 today
  const report = buildUsageSummaryReport({
    allEvents: [
      {
        event_key: 'a'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 100,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now - 60,
      },
      {
        event_key: 'b'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 200,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 200,
        timestamp_seconds: tomorrowStart + 3600,
      },
    ],
    effectiveEvents: [
      {
        event_key: 'a'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 100,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now - 60,
      },
      {
        event_key: 'b'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 200,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 200,
        timestamp_seconds: tomorrowStart + 3600,
      },
    ],
    knownReceiptKeys: new Set(),
    unattributedRequests: 0,
    unattributedTokens: 0,
    accountMap: new Map([['all', { id: 'all', label: 'All', type: 'all', total_tokens: 0, request_count: 0 }]]),
    accountId: 'all',
    accKey: 'all',
    now,
    rawPricing: {},
    pricing: {},
    calKey: todayStr,
    rateLocks: {},
    resolvePricing: () => null,
    lockedCost: () => null,
    dbPathsCount: 1,
    archivedDbCount: 0,
    lastDiscoveredDatabaseCount: 1,
    cachedDatabasesCount: 0,
    liveEventsCount: 2,
    generationsScanned: 2,
    skippedLargeRecords: 0,
    failedDatabasesCount: 0,
    diagnostics: [],
    ledgerCorrupt: false,
    archivedUnavailable: false,
    storageWarnings: new Set(),
    pricingWarnings: [],
  });
  assert.equal(report.all_time.totals.request_count, 2);
  assert.equal(report.today.totals.request_count, 1);
  assert.equal(report.daily_trends.length, 30);
  assert.equal(report.daily_trends.at(-1)?.date, todayStr);
  assert.equal(report.daily_trends.some(d => d.date > todayStr), false);
  assert.equal(report.daily_trends.at(-1)?.request_count, 1);
  assert.equal(report.today_hourly.reduce((s, h) => s + h.request_count, 0), 1);

  // P1-13: allEvents 非空而 effectiveEvents 为空时，不得仅因筛选/未归属空集错标为 unavailable
  const filteredEmptyReport = buildUsageSummaryReport({
    allEvents: [
      {
        event_key: 'c'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 50,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 50,
        timestamp_seconds: now - 60,
      },
    ],
    effectiveEvents: [],
    knownReceiptKeys: new Set(),
    unattributedRequests: 0,
    unattributedTokens: 0,
    accountMap: new Map([['all', { id: 'all', label: 'All', type: 'all', total_tokens: 0, request_count: 0 }]]),
    accountId: 'acc-empty',
    accKey: 'acc-empty',
    now,
    rawPricing: {},
    pricing: {},
    calKey: todayStr,
    rateLocks: {},
    resolvePricing: () => null,
    lockedCost: () => null,
    dbPathsCount: 0,
    archivedDbCount: 0,
    lastDiscoveredDatabaseCount: 0,
    cachedDatabasesCount: 0,
    liveEventsCount: 0,
    generationsScanned: 0,
    skippedLargeRecords: 0,
    failedDatabasesCount: 1,
    diagnostics: [],
    ledgerCorrupt: false,
    archivedUnavailable: false,
    storageWarnings: new Set(),
    pricingWarnings: [],
  });
  assert.equal(filteredEmptyReport.availability, 'partial');

  // 2. aggregateLedger 同样拦截 >= tomorrowStart 的未来时间戳进入 daily_trends
  await withFixture(t, async ({ stateDir, geminiDir }) => {
    const ledger = new UsageLedger(join(stateDir, 'agg-future'));
    await ledger.save([
      {
        event_key: 'd'.repeat(64),
        source_id: 's1',
        model: 'gemini-2.5-flash',
        input_tokens: 100,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now - 60,
      },
      {
        event_key: 'e'.repeat(64),
        source_id: 's2',
        model: 'gemini-2.5-flash',
        input_tokens: 200,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 200,
        timestamp_seconds: tomorrowStart + 3600,
      },
    ]);
    const agg = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(agg.all_time.totals.request_count, 2);
    assert.equal(agg.today.totals.request_count, 1);
    assert.equal(agg.daily_trends.length, 30);
    assert.equal(agg.daily_trends.at(-1)?.date, todayStr);
    assert.equal(agg.daily_trends.some(d => d.date > todayStr), false);
    assert.equal(agg.daily_trends.at(-1)?.request_count, 1);

    // 3. 失败缓存跨午夜失效：23:59:50 成功写入缓存 -> 00:00:05 扫描失败时不得返回昨天的 cachedSummary
    const RealDate = Date;
    let fakeNowMs = new RealDate(2026, 10, 15, 23, 59, 50, 0).getTime();
    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fakeNowMs]));
      }
      static now() {
        return fakeNowMs;
      }
    }
    globalThis.Date = FixedDate;
    t.after(() => {
      globalThis.Date = RealDate;
    });

    const mgr = new UsageStatsManager({ stateDir: join(stateDir, 'midnight'), geminiDir });
    const eventTs = Math.floor(new RealDate(2026, 10, 15, 23, 50, 0, 0).getTime() / 1000);
    let failDb = false;
    mgr.discoverDatabaseFiles = async () => ['synthetic-midnight.db'];
    mgr.scanDatabaseEvents = async () => {
      if (failDb) {
        return { events: [], generationsScanned: 0, skippedLargeRecords: 0, hasError: true, error: 'read failed' };
      }
      return {
        events: [
          {
            event_key: 'f'.repeat(64),
            source_id: 's-mid',
            model: 'gemini-2.5-flash',
            input_tokens: 100,
            output_tokens: 0,
            cached_tokens: 0,
            total_tokens: 100,
            timestamp_seconds: eventTs,
          },
        ],
        generationsScanned: 1,
        skippedLargeRecords: 0,
      };
    };

    const day1 = await mgr.getUsageSummary(true);
    assert.equal(day1.today.totals.request_count, 1);

    fakeNowMs = new RealDate(2026, 10, 16, 0, 0, 5, 0).getTime();
    failDb = true;
    const day2 = await mgr.getUsageSummary(false);
    assert.equal(day2.today.totals.request_count, 0, '跨午夜后遇到读取失败不能复用前一日 cached 汇总');
  });
});

test('P1-11 & P1-12: revalueLedger 轻量级快照库、排除项对齐、dryRun/restore、confirmed $0 保留与 saveLocks 删除遗留锁', async t => {
  await withFixture(t, async ({ stateDir }) => {
    const ledger = new UsageLedger(join(stateDir, 'revalue-store'));
    const now = Math.floor(Date.now() / 1000);
    const kPriced = '1'.repeat(64);
    const kConfirmedFree = '2'.repeat(64);
    const kZeroSentinel = '3'.repeat(64);
    const kSynthetic = '4'.repeat(64);
    const kLiveNoSource = '5'.repeat(64);
    const kStale = '6'.repeat(64);

    await ledger.save([
      {
        event_key: kPriced,
        source_id: 's1',
        db_file: 'live.db',
        model: 'test-paid',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 100,
      },
      {
        event_key: kConfirmedFree,
        source_id: 's2',
        db_file: 'live.db',
        model: 'free-model',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 90,
      },
      {
        event_key: kZeroSentinel,
        source_id: 's3',
        db_file: 'live.db',
        model: 'test-paid',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 80,
      },
      {
        event_key: kSynthetic,
        source_id: 's4',
        db_file: 'recovered_session.db',
        model: 'test-paid',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 70,
      },
      {
        event_key: kLiveNoSource,
        db_file: 'live.db',
        model: 'test-paid',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 60,
      },
    ]);

    // P1-12: saveLocks 必须清理不再存在的旧键
    await ledger.saveLocks({
      [kPriced]: { usd: 9.99, price: { model: 'test-paid', input: 9.99, output: 0, cached: 0 } },
      [kConfirmedFree]: { usd: 0, price: { model: 'free-model', input: 0, output: 0, cached: 0, provenance: { verification: 'confirmed' } } },
      [kZeroSentinel]: { usd: 0, price: { model: 'test-paid', input: 0, output: 0, cached: 0 } },
      [kSynthetic]: { usd: 50, price: { model: 'test-paid', input: 50, output: 0, cached: 0 } },
      [kLiveNoSource]: { usd: 40, price: { model: 'test-paid', input: 40, output: 0, cached: 0 } },
      [kStale]: { usd: 1, price: { model: 'stale', input: 1, output: 0, cached: 0 } },
    });
    assert.equal(Object.hasOwn(await ledger.locks(), kStale), true);

    await ledger.saveLocks({
      [kPriced]: { usd: 9.99, price: { model: 'test-paid', input: 9.99, output: 0, cached: 0 } },
      [kConfirmedFree]: { usd: 0, price: { model: 'free-model', input: 0, output: 0, cached: 0, provenance: { verification: 'confirmed' } } },
      [kZeroSentinel]: { usd: 0, price: { model: 'test-paid', input: 0, output: 0, cached: 0 } },
      [kSynthetic]: { usd: 50, price: { model: 'test-paid', input: 50, output: 0, cached: 0 } },
      [kLiveNoSource]: { usd: 40, price: { model: 'test-paid', input: 40, output: 0, cached: 0 } },
    });
    assert.equal(Object.hasOwn(await ledger.locks(), kStale), false, 'P1-12: saveLocks 必须删除已被淘汰的遗留锁');

    const prices = {
      'test-paid': { model: 'test-paid', input: 2.0, output: 0, cached: 0 },
      'free-model': { model: 'free-model', input: 5.0, output: 0, cached: 0 },
    };

    // mode: unpriced_only 仅重估未定价值守卫 (kZeroSentinel -> $2)，保留 kPriced ($9.99) 与 confirmed $0 (kConfirmedFree)
    const previewUnpriced = await ledger.revalue({
      action: 'preview',
      mode: 'unpriced_only',
      prices,
      liveFiles: ['live.db'],
      now,
    });
    assert.equal(previewUnpriced.before, 9.99);
    assert.equal(previewUnpriced.after, 11.99);

    // 轻量快照库：backup 与 candidate 仅含 rate_locks，绝不复制全量 events/event_revisions 表
    for (const dbFile of [previewUnpriced.backup, previewUnpriced.candidate]) {
      const snapDb = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const tables = snapDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        assert.equal(tables.includes('rate_locks'), true);
        assert.equal(tables.includes('events'), false);
        assert.equal(tables.includes('event_revisions'), false);
      } finally {
        snapDb.close();
      }
    }

    // dryRun preview 不得改动主库锁表
    assert.equal((await ledger.locks())[kZeroSentinel].usd, 0);

    // force_all 预览 + apply + restore 全闭环
    const previewAll = await ledger.revalue({
      action: 'preview',
      mode: 'force_all',
      prices,
      liveFiles: ['live.db'],
      now,
    });
    assert.equal(previewAll.before, 9.99);
    assert.equal(previewAll.after, 9.0); // kPriced (2) + kConfirmedFree (5) + kZeroSentinel (2)

    await ledger.revalue({
      action: 'apply',
      previewId: previewAll.previewId,
      confirmed: true,
      prices,
      liveFiles: ['live.db'],
      now,
    });
    assert.equal((await ledger.aggregate({ prices, accountId: 'all', accounts: [], liveFiles: ['live.db'], now })).all_time.estimated_usd, 9.0);

    await ledger.revalue({
      action: 'restore',
      previewId: previewAll.previewId,
      confirmed: true,
      prices,
      liveFiles: ['live.db'],
      now,
    });
    const restoredLocks = await ledger.locks();
    assert.equal(restoredLocks[kPriced].usd, 9.99);
    assert.equal(restoredLocks[kZeroSentinel].usd, 0);
    assert.equal((await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], liveFiles: ['live.db'], now })).all_time.estimated_usd, 9.99);
    assert.equal((await ledger.aggregate({ prices, accountId: 'all', accounts: [], liveFiles: ['live.db'], now })).all_time.estimated_usd, 11.99);
  });
});

test('P1-13 & P1-14: >16MB 未投影 steps 计入 skippedLargeRecords、getUsageEvents all 快照子账号过滤与 xhigh 模型检索', async t => {
  await withFixture(t, async ({ stateDir, geminiDir, convDir }) => {
    // 1. >16MB 未投影 steps 触发 skippedLargeRecords++
    const bigStepsDb = join(convDir, 'big-steps.db');
    const db = new DatabaseSync(bigStepsDb);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
    const genBlob = Buffer.concat([
      W.encodeLengthDelimited(
        1,
        Buffer.concat([W.encodeString(19, 'gemini-2.5-flash'), W.encodeLengthDelimited(4, W.encodeVarintField(2, 42))])
      ),
      W.encodeLengthDelimited(2, W.encodeVarint(130)),
    ]);
    db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, genBlob);
    // field 9 length-delimited 超过 STEP_PROJECTION 安全上限，导致 projectBlob 失败且 size > 16MB
    const oversizedStepMeta = W.encodeLengthDelimited(9, Buffer.alloc(16 * 1024 * 1024 + 64));
    db.prepare('INSERT INTO steps VALUES(?,15,?)').run(130, oversizedStepMeta);
    db.close();

    const scannerMgr = new UsageStatsManager({ stateDir: join(stateDir, 'scan'), geminiDir });
    const scan = await scannerMgr.scanDatabaseEvents(bigStepsDb);
    assert.equal(scan.skippedLargeRecords, 1, '超过 16MB 且未成功投影的 steps 行必须计入 skippedLargeRecords');

    // 2. getUsageEvents 在 'all' 快照下支持按 accountId 子过滤，且 ledger/events 搜索归一化 xhigh/extra-high
    const now = Math.floor(Date.now() / 1000);
    const mgr = new UsageStatsManager({ stateDir: join(stateDir, 'events'), geminiDir });
    mgr.setKnownAccounts([
      { id: 'acc-1', email: 'one@example.invalid', name: 'One' },
      { id: 'acc-2', email: 'two@example.invalid', name: 'Two' },
    ]);
    mgr.discoverDatabaseFiles = async () => ['synthetic-events.db'];
    mgr.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: '7'.repeat(64),
          source_id: 's-acc1',
          model: 'claude-opus-5-5-xhigh',
          input_tokens: 100,
          output_tokens: 50,
          cached_tokens: 0,
          total_tokens: 150,
          timestamp_seconds: now - 30,
          account_id: 'acc-1',
          account_email: 'one@example.invalid',
          account_confidence: 'observed',
        },
        {
          event_key: '8'.repeat(64),
          source_id: 's-acc2',
          model: 'gemini-3.8-flash-extra-high',
          input_tokens: 200,
          output_tokens: 50,
          cached_tokens: 0,
          total_tokens: 250,
          timestamp_seconds: now - 20,
          account_id: 'acc-2',
          account_email: 'two@example.invalid',
          account_confidence: 'observed',
        },
      ],
      generationsScanned: 2,
      skippedLargeRecords: 0,
    });

    const allSummary = await mgr.getUsageSummary(true, 'all');
    const acc1Filtered = await mgr.getUsageEvents('all', '', 0, 20, allSummary.snapshot_id, false, false, 'acc-1');
    assert.equal(acc1Filtered.total, 1);
    assert.equal(acc1Filtered.rows[0].account_id, 'acc-1');
    assert.equal(acc1Filtered.rows[0].model, 'claude-opus-5-5-xhigh');

    // 3. ledgerEventPage 归一化查询：xhigh / extra-high 与占位符别名映射
    const ledger = new UsageLedger(join(stateDir, 'search-norm'));
    await ledger.save([
      {
        event_key: '7'.repeat(64),
        source_id: 's-acc1',
        model: 'claude-opus-5-5-xhigh',
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 0,
        total_tokens: 150,
        timestamp_seconds: now - 30,
        account_id: 'acc-1',
        account_email: 'one@example.invalid',
      },
      {
        event_key: '8'.repeat(64),
        source_id: 's-acc2',
        model: 'MODEL_PLACEHOLDER_M669',
        input_tokens: 200,
        output_tokens: 50,
        cached_tokens: 0,
        total_tokens: 250,
        timestamp_seconds: now - 20,
        account_id: 'acc-2',
        account_email: 'two@example.invalid',
      },
    ]);
    const agg = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    const opusPage = await ledger.events({
      snapshot: agg.ledger_snapshot,
      period: 'all',
      query: 'claude-opus-5-5-extra-high',
      offset: 0,
      limit: 20,
    });
    assert.equal(opusPage.total, 1);
    assert.equal(opusPage.rows[0].account_id, 'acc-1');

    const flashPage = await ledger.events({
      snapshot: agg.ledger_snapshot,
      period: 'all',
      query: 'gemini-3.8-flash',
      offset: 0,
      limit: 20,
    });
    assert.equal(flashPage.total, 1);
    assert.equal(flashPage.rows[0].model, 'gemini-3.8-flash');
  });
});

test('P1-3: 未知模型盘上语言中立存储与中英切换零分裂聚合/检索', async t => {
  const prevLocale = getActiveLocale();
  t.after(() => setActiveLocale(prevLocale));

  await withFixture(t, async ({ stateDir, geminiDir, convDir }) => {
    const unknownDb = join(convDir, 'unknown-locale-neutral.db');
    const now = Math.floor(Date.now() / 1000);
    const db = new DatabaseSync(unknownDb);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
    const genBlob = Buffer.concat([
      W.encodeLengthDelimited(1, W.encodeLengthDelimited(4, W.encodeVarintField(2, 120))),
      W.encodeLengthDelimited(2, W.encodeVarint(1)),
    ]);
    db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(genBlob);
    const stepMeta = Buffer.concat([
      W.encodeLengthDelimited(1, W.encodeVarintField(1, now - 30)),
      W.encodeLengthDelimited(9, W.encodeVarintField(2, 120)),
    ]);
    db.prepare('INSERT INTO steps VALUES(1,15,?)').run(stepMeta);
    db.close();

    setActiveLocale('en');
    const mgr = new UsageStatsManager({ stateDir: join(stateDir, 'neutral-unknown'), geminiDir });
    const scannedEn = await mgr.scanDatabaseEvents(unknownDb);
    assert.equal(scannedEn.events.length, 1);
    assert.equal(scannedEn.events[0].model, '未知模型');

    const ledger = new UsageLedger(join(stateDir, 'neutral-ledger'));
    await ledger.save([
      scannedEn.events[0],
      {
        event_key: '9'.repeat(64),
        source_id: 'legacy-en-unknown',
        model: 'Unknown Model',
        input_tokens: 80,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now - 15,
      },
    ]);

    setActiveLocale('en');
    const aggEn = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(aggEn.all_time.by_model.length, 1);
    assert.equal(aggEn.all_time.by_model[0].model, 'Unknown Model');
    assert.equal(aggEn.all_time.by_model[0].request_count, 2);

    const searchEn = await ledger.events({
      snapshot: aggEn.ledger_snapshot,
      period: 'all',
      query: 'unknown model',
      offset: 0,
      limit: 10,
    });
    assert.equal(searchEn.total, 2);
    assert.ok(searchEn.rows.every(r => r.model === 'Unknown Model'));

    setActiveLocale('zh-Hans');
    const aggZh = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(aggZh.all_time.by_model.length, 1);
    assert.equal(aggZh.all_time.by_model[0].model, '未知模型');
    assert.equal(aggZh.all_time.by_model[0].request_count, 2);
  });
});

test('跨 source_id 三轮以上归并、存量重复自愈、稳定 source_id 与大总账持久化缓存', async t => {
  await withFixture(t, async ({ stateDir, geminiDir, convDir }) => {
    const now = Math.floor(Date.now() / 1000);

    // 1. 验证连续 3 次 source_id 漂移（含 timestamp=0 补齐及不同观察顺序）不产生重复计数，并保留 observed 归属与 rate_locks
    const multiLedger = new UsageLedger(join(stateDir, 'multi-src-dedup'));
    const legKey = createHash('sha256').update('legacy-multi-src-1').digest('hex');
    const k1 = 'a'.repeat(64);
    const k2 = 'b'.repeat(64);
    const k3 = 'c'.repeat(64);
    const k4 = 'd'.repeat(64);
    const accounts = [{ id: 'acc-1', email: 'alice@example.invalid', name: 'Alice' }];

    await multiLedger.save([
      {
        event_key: k1,
        source_id: 'src-dev-16',
        db_file: 'conv-dup.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-3.8-flash',
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 0,
        total_tokens: 1500,
        timestamp_seconds: 0,
        account_id: 'acc-1',
        account_email: 'alice@example.invalid',
        account_confidence: 'observed',
        source_observed_at: 100,
      },
    ]);
    await multiLedger.saveLocks({
      [k1]: { usd: 0.2, price: { model: 'gemini-3.8-flash', input: 100, output: 200, cached: 1 } },
    });

    // 第 2 轮（dev 变化）并补齐真实时间戳
    await multiLedger.save([
      {
        event_key: k2,
        source_id: 'src-dev-15',
        db_file: 'conv-dup.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-3.8-flash',
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 0,
        total_tokens: 1500,
        timestamp_seconds: now - 120,
        account_confidence: 'unknown',
        source_observed_at: 200,
      },
    ]);

    // 第 3、4 轮（继续变换 source_id，模拟多次重启后跨版本迁移）
    await multiLedger.save([
      {
        event_key: k3,
        source_id: 'src-dev-14',
        db_file: 'conv-dup.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-3.8-flash',
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 0,
        total_tokens: 1500,
        timestamp_seconds: now - 120,
        account_confidence: 'unknown',
        source_observed_at: 300,
      },
    ]);
    await multiLedger.save([
      {
        event_key: k4,
        source_id: 'src-stable',
        db_file: 'conv-dup.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-3.8-flash',
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 0,
        total_tokens: 1500,
        timestamp_seconds: now - 120,
        account_confidence: 'unknown',
        source_observed_at: 400,
      },
    ]);

    const aggMulti = await multiLedger.aggregate({ prices: {}, accountId: 'all', accounts, now });
    assert.equal(aggMulti.all_time.totals.request_count, 1, '4 轮 source_id 漂移后只能统计 1 条');
    assert.equal(aggMulti.all_time.totals.total_tokens, 1500);
    assert.equal(aggMulti.all_time.estimated_usd, 0.2);
    assert.equal(aggMulti.historical_amount_receipts?.unmatchedCount, 0);
    const aliceSummary = aggMulti.available_accounts?.find(a => a.id === 'acc-1');
    assert.equal(aliceSummary?.request_count, 1, '归并后必须保留 observed 账号归属');
    const pageMulti = await multiLedger.events({ snapshot: aggMulti.ledger_snapshot, period: 'all', query: '', offset: 0, limit: 10 });
    assert.equal(pageMulti.total, 1);
    assert.equal(pageMulti.rows[0].account_id, 'acc-1');

    // 2. 验证存量损坏库（两条同 legacy_event_key 均未进 event_aliases）在首次 aggregate 时自动自愈去重
    const dirtyState = join(stateDir, 'dirty-ledger');
    await mkdir(dirtyState, { recursive: true });
    const dirtyDbPath = join(dirtyState, 'usage-ledger-v2.sqlite');
    const rawDb = new DatabaseSync(dirtyDbPath);
    rawDb.exec(`
      CREATE TABLE events(event_key TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, account_id TEXT, model TEXT NOT NULL, payload TEXT NOT NULL, observed_at REAL NOT NULL DEFAULT 0);
      CREATE TABLE event_revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE rate_locks(event_key TEXT PRIMARY KEY,unit_price TEXT NOT NULL,usd REAL NOT NULL);
      CREATE TABLE event_aliases(legacy_key TEXT PRIMARY KEY,event_key TEXT NOT NULL);
      CREATE TABLE rate_changes(version INTEGER PRIMARY KEY,min_event_seq INTEGER NOT NULL);
      CREATE TABLE snapshot_pins(snapshot_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE ledger_maintenance(key TEXT PRIMARY KEY,last_run INTEGER NOT NULL);
      PRAGMA user_version=2;
    `);
    const dupLegacy = createHash('sha256').update('legacy-corrupt-dup').digest('hex');
    const oldWin = '1'.repeat(64);
    const newDup = '2'.repeat(64);
    const pOld = JSON.stringify({
      event_key: oldWin,
      source_id: 'old-src',
      db_file: 'archived-conv.db',
      generation_index: 5,
      legacy_event_key: dupLegacy,
      model: 'gemini-3.8-flash',
      input_tokens: 2000,
      output_tokens: 500,
      cached_tokens: 0,
      total_tokens: 2500,
      timestamp_seconds: now - 3600,
      account_id: 'acc-1',
      account_email: 'alice@example.invalid',
      account_confidence: 'observed',
      source_observed_at: 1000,
      ingested_at: '2026-11-12T10:00:00.000Z',
    });
    const pNew = JSON.stringify({
      event_key: newDup,
      source_id: 'new-src',
      db_file: 'archived-conv.db',
      generation_index: 5,
      legacy_event_key: dupLegacy,
      model: 'gemini-3.8-flash',
      input_tokens: 2000,
      output_tokens: 500,
      cached_tokens: 0,
      total_tokens: 2500,
      timestamp_seconds: now - 3600,
      account_confidence: 'unknown',
      source_observed_at: 2000,
      ingested_at: '2026-11-12T10:00:00.000Z',
    });
    rawDb.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(oldWin, now - 3600, 'acc-1', 'gemini-3.8-flash', pOld, 1000);
    rawDb.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(newDup, now - 3600, null, 'gemini-3.8-flash', pNew, 2000);
    rawDb.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)').run(oldWin, now - 3600, pOld);
    rawDb.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)').run(newDup, now - 3600, pNew);
    rawDb.prepare('INSERT INTO rate_locks VALUES(?,?,?)').run(oldWin, JSON.stringify({ model: 'gemini-3.8-flash', input: 100, output: 200, cached: 1 }), 0.3);
    rawDb.close();

    const healedLedger = new UsageLedger(dirtyState);
    const aggHealed = await healedLedger.aggregate({ prices: {}, accountId: 'all', accounts, now });
    assert.equal(aggHealed.all_time.totals.request_count, 1, '存量未遮蔽重复行应在 aggregate 时自动去重');
    assert.equal(aggHealed.all_time.totals.total_tokens, 2500);
    assert.equal(aggHealed.all_time.estimated_usd, 0.3, '胜出者必须继承旧行已锁定的 rate_locks');
    assert.equal(aggHealed.available_accounts?.find(a => a.id === 'acc-1')?.request_count, 1, '胜出者必须保留 observed 账号归属');
    assert.equal((await healedLedger.load()).length, 1, 'load() 也应过滤已被 alias 遮蔽的旧记录');

    // 3. 验证 source_id 不受 fileStat.dev 影响（仅由 basename + ino + birthtimeMs 决定）
    const stableDb = join(convDir, 'stable-source-id.db');
    const sdb = new DatabaseSync(stableDb);
    sdb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
    const genBlob = Buffer.concat([
      W.encodeLengthDelimited(
        1,
        Buffer.concat([
          W.encodeLengthDelimited(4, W.encodeVarintField(2, 300)),
          W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, now - 20))),
        ])
      ),
      W.encodeLengthDelimited(2, W.encodeVarint(1)),
    ]);
    sdb.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(genBlob);
    sdb.close();

    const st = await lstat(stableDb);
    const expectedSourceId = createHash('sha256')
      .update(JSON.stringify([basename(stableDb), st.ino, st.birthtimeMs]))
      .digest('hex');
    const persistPath = join(stateDir, 'persist-file-cache.json');
    const mgr = new UsageStatsManager({
      stateDir: join(stateDir, 'scanner-state'),
      geminiDir,
    });
    mgr.persistCachePath = persistPath;
    const scanRes = await mgr.scanDatabaseEvents(stableDb);
    assert.equal(scanRes.events.length, 1);
    assert.equal(scanRes.events[0].source_id, expectedSourceId, 'source_id 必须脱离易漂移的 dev 字段');

    // 4. 验证 largeLedger 分支也会保存持久化文件缓存
    mgr.largeLedger = true;
    await mgr.getUsageSummary(true);
    await new Promise(resolve => setTimeout(resolve, 150));
    const persistedRaw = JSON.parse(await readFile(persistPath, 'utf8'));
    assert.ok(persistedRaw?.entries?.[stableDb], 'largeLedger 分支下也必须持久化文件缓存');
  });
});

