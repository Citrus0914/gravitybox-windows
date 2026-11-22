import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { canonicalPayload, IdempotencyStore } from "../dist/ipc-idempotency.js";
import { controlEndpointForStateDir } from "../dist/platform/paths.js";
import { ProtobufWriter } from "../dist/protobuf.js";

describeContractGroup("undefined · optimization-20261023", { concurrency: false }, async () => {
  test('幂等性保留所有业务id，传输requestId可变，异目标必须冲突', () => {
    assert.deepEqual(
      canonicalPayload({ requestId: 'one', idempotencyKey: 'k', id: 'a', data: { id: 'nested' } }),
      canonicalPayload({ requestId: 'two', idempotencyKey: 'k', id: 'a', data: { id: 'nested' } })
    );
    assert.notDeepEqual(canonicalPayload({ id: 'a' }), canonicalPayload({ id: 'b' }));
    assert.notDeepEqual(canonicalPayload({ data: { id: 'a' } }), canonicalPayload({ data: { id: 'b' } }));
    const store = new IdempotencyStore();
    assert.equal(store.reserve('k', 'target-a', () => {}), 'owner');
    assert.equal(store.reserve('k', 'target-b', () => {}), 'conflict');
  });
});

describeContractGroup("undefined · v090-engines", { concurrency: false }, async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function until(fn, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await fn();
      if (val) return val;
      await sleep(30);
    }
    throw new Error('等待超时');
  }

  function rpc(directory, payload) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(controlEndpointForStateDir(directory));
      let value = '';
      socket.setTimeout(4000, () => {
        socket.destroy();
        reject(new Error('IPC 超时'));
      });
      socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
      socket.on('error', reject);
      socket.on('data', chunk => {
        value += chunk;
        if (value.includes('\n')) {
          socket.end();
          try { resolve(JSON.parse(value.split('\n')[0])); } catch (e) { reject(e); }
        }
      });
    });
  }

  test('Main IPC 集成测试: Token 用量、定价基准、HUD 开关与维护目录契约', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'gb-ipc-090-'));
    const mockGeminiDir = join(directory, 'gemini');
    const mockConvDir = join(mockGeminiDir, 'antigravity', 'conversations');
    await mkdir(mockConvDir, { recursive: true });
    const mockDbPath = join(mockConvDir, 'ipc-metrics.db');
    const nowSec = Math.floor(Date.now() / 1000);
    const f19 = ProtobufWriter.encodeString(19, 'gemini-3.8-flash');
    const uMsg = Buffer.concat([
      ProtobufWriter.encodeVarintField(1, 1318),
      ProtobufWriter.encodeVarintField(2, 600),
      ProtobufWriter.encodeVarintField(3, 800),
      ProtobufWriter.encodeVarintField(5, 1200),
    ]);
    const f4 = ProtobufWriter.encodeLengthDelimited(4, uMsg);
    const tInner = ProtobufWriter.encodeLengthDelimited(4, ProtobufWriter.encodeVarintField(1, nowSec));
    const f9 = ProtobufWriter.encodeLengthDelimited(9, tInner);
    const genBlob = ProtobufWriter.encodeLengthDelimited(1, Buffer.concat([f19, f4, f9]));

    const conn = new DatabaseSync(mockDbPath);
    try {
      conn.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, status INTEGER, step_payload BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
      conn.prepare('INSERT INTO gen_metadata (idx, data) VALUES (1, ?);').run(genBlob);
    } finally { conn.close(); }

    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../dist/main.js', import.meta.url)),
        '--state-dir', directory,
        '--app', '/nonexistent',
        '--profile', join(directory, 'profile'),
        '--gemini-dir', mockGeminiDir,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env } }
    );
    let errors = '';
    child.stderr.on('data', b => { errors += b; });
    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    await until(async () => { try { return (await rpc(directory, { command: 'status' })).ok; } catch { return false; } });

    const summary = await rpc(directory, { command: 'dashboard_summary' });
    assert.equal(summary.ok, true);
    assert.ok(summary.usage);
    assert.ok(summary.usage.todayTokens > 0);
    assert.ok(summary.usage.totalTokens > 0);

    const usageRes = await rpc(directory, { command: 'usage_summary', period: 'today' });
    assert.equal(usageRes.ok, true);
    assert.equal(usageRes.period, 'today');
    assert.equal(usageRes.summary.today, undefined, '导出不能夹带其他周期的汇总');
    assert.equal(typeof usageRes.snapshotId, 'string');
    assert.equal(typeof usageRes.summary.totalTokens, 'number');
    assert.ok(Array.isArray(usageRes.byModel));

    const pricingRes = await rpc(directory, { command: 'api_pricing_get' });
    assert.equal(pricingRes.ok, true);
    assert.ok(pricingRes.prices['gemini-3.8-flash']);
    const offlineSyncCheck = await rpc(directory, {
      command: 'pricing_sync_check',
      feedUrl: 'http://127.0.0.1:1/unreachable-pricing-feed.json',
    });
    assert.equal(offlineSyncCheck.ok, true);
    assert.equal(offlineSyncCheck.synced, false);
    assert.ok(offlineSyncCheck.prices['gemini-3.8-flash']);

    const { CACHE_METADATA, getCacheMetadata } = await import('../dist/maintenance-catalog.js');
    const { setActiveLocale, getActiveLocale } = await import('../dist/i18n.js');
    const prevLocale = getActiveLocale();
    t.after(() => setActiveLocale(prevLocale));
    const catalogKeys = Object.keys(CACHE_METADATA);
    assert.ok(catalogKeys.length > 0);
    setActiveLocale('zh-Hans');
    const zhTitle = CACHE_METADATA[catalogKeys[0]].title;
    assert.equal(zhTitle, getCacheMetadata(catalogKeys[0]).title);
    setActiveLocale('en');
    const enTitle = CACHE_METADATA[catalogKeys[0]].title;
    assert.notEqual(zhTitle, enTitle, 'CACHE_METADATA 代理必须随运行态语言动态变化');

    assert.equal(errors, '');
    await rpc(directory, { command: 'stop' });
    await until(async () => child.exitCode === 0);
  });
});
