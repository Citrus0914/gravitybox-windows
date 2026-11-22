import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlEndpointForStateDir } from '../dist/platform/paths.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const importState = await mkdtemp(join(tmpdir(), 'gb-p4-import-'));
const savedArgv = process.argv.slice();
process.argv.push(
  '--state-dir', importState, '--app', '/nonexistent', '--profile', join(importState, 'profile'),
  '--gemini-dir', join(importState, 'gemini'), '--home-dir', importState, '--app-support-dir', importState,
);
process.env.GRAVITYBOX_IMPORT_ONLY = '1';
const { buildDashboardAggregate } = await import('../dist/main.js');
process.argv.length = 0;
process.argv.push(...savedArgv);
delete process.env.GRAVITYBOX_IMPORT_ONLY;
after(async () => { await rm(importState, { recursive: true, force: true }); });

function healthyDeps(overrides = {}) {
  return {
    getUsageSummary: async () => ({
      today: { totals: { total_tokens: 1234, input_tokens: 1000, output_tokens: 234, cached_tokens: 0, request_count: 5 }, estimated_usd: 0.5 },
      all_time: { totals: { total_tokens: 9999, input_tokens: 8000, output_tokens: 1999, cached_tokens: 0, request_count: 40 }, estimated_usd: 3.2 },
      unpriced_models: 1,
      priced_models: 2,
      databases_scanned: 3,
      databases_discovered: 5,
      scan_scope_description: '最近活跃 3 个会话库',
      has_error: false,
      failed_databases_count: 0,
    }),
    getPricingTable: async () => ({ a: {}, b: {} }),
    ...overrides,
  };
}

test('B12: usage 聚合成功返回今日与累计统计', async () => {
  const result = await buildDashboardAggregate(healthyDeps());
  assert.equal(result.usageError, '');
  assert.ok(result.usage);
  assert.equal(result.usage.todayTokens, 1234);
  assert.equal(result.usage.totalTokens, 9999);
});

test('B12: usage 聚合失败返回脱敏 usageError（不含物理路径与凭据）', async () => {
  const deps = healthyDeps({
    getUsageSummary: async () => { throw new Error('读取用量库失败 /private/var/folders/x/usage.sqlite token=ya29.abcdefghijklmnop'); },
  });
  const result = await buildDashboardAggregate(deps);
  assert.equal(result.usage, null);
  assert.ok(result.usageError.length > 0);
  assert.equal(result.usageError.includes('/private/'), false, '错误不得泄漏绝对路径');
  assert.equal(result.usageError.includes('ya29.'), false, '错误不得泄漏凭据');
});

function rpc(directory, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlEndpointForStateDir(directory));
    const chunks = [];
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('IPC 超时')); });
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (!buffer.includes(0x0a)) return;
      socket.end();
      try { resolve(JSON.parse(buffer.toString('utf8').split('\n')[0])); } catch { reject(new Error('响应格式错误')); }
    });
  });
}

async function until(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(30); }
  throw new Error('测试等待超时');
}

test('B12: 真实后台 dashboard_summary 返回 usage 与 usageError', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-p4-contract-'));
  const child = spawn(process.execPath, [
    join(root, 'dist/main.js'),
    '--state-dir', directory,
    '--app', '/nonexistent',
    '--profile', join(directory, 'nonexistent-profile'),
    '--gemini-dir', join(directory, 'gemini'),
    '--home-dir', directory,
    '--app-support-dir', directory,
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env } });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await until(async () => { try { return (await rpc(directory, { command: 'status' })).ok; } catch { return false; } });
    const dashboard = await rpc(directory, { command: 'dashboard_summary' });
    assert.equal(dashboard.ok, true);
    assert.equal(typeof dashboard.usageError, 'string');
    assert.equal(dashboard.usageError, '');
    assert.ok(dashboard.usage && typeof dashboard.usage === 'object');

    assert.equal((await rpc(directory, { command: 'stop' })).ok, true);
    await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
  assert.doesNotMatch(errors, /\[GravityBox\]/, '后台进程不得输出异常日志');
});
