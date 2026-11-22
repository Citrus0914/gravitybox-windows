import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { UsageStatsManager } from '../dist/usage.js';
import { parsePrimaryWorkspace } from '../dist/usage-conversations.js';
import { ledgerBreakdownBuckets } from '../dist/usage-aggregate.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';
import { controlEndpointForStateDir } from '../dist/platform/paths.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function makeGenBlob(model, input, output, cached, tsSec) {
  const usage = Buffer.concat([
    W.encodeVarintField(1, 1318),
    W.encodeVarintField(2, input),
    W.encodeVarintField(3, output),
    W.encodeVarintField(5, cached),
  ]);
  const timingInner = W.encodeLengthDelimited(4, W.encodeVarintField(1, tsSec));
  const wrapped = Buffer.concat([
    W.encodeString(19, model),
    W.encodeLengthDelimited(4, usage),
    W.encodeLengthDelimited(9, timingInner),
  ]);
  return W.encodeLengthDelimited(1, wrapped);
}

function createConvDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    const insert = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
    rows.forEach((r, idx) => {
      insert.run(idx + 1, makeGenBlob(r.model, r.input, r.output, r.cached, r.tsSec));
    });
  } finally {
    db.close();
  }
}

test('parsePrimaryWorkspace 正确解析 Windows 编码 URI、POSIX URI 与空输入', () => {
  assert.deepEqual(
    parsePrimaryWorkspace('["file:///f%3A/workspace/%E9%A1%B9%E7%9B%AE%E7%94%B2"]'),
    { path: 'F:/workspace/项目甲', name: '项目甲' }
  );
  assert.deepEqual(
    parsePrimaryWorkspace('["file:///Users/demo/sample-app"]'),
    { path: '/Users/demo/sample-app', name: 'sample-app' }
  );
  assert.equal(parsePrimaryWorkspace(''), null);
  assert.equal(parsePrimaryWorkspace('[]'), null);
  assert.equal(parsePrimaryWorkspace('not-json'), null);
});

test('UsageStatsManager.getUsageBreakdown 聚合项目重命名合并、子智能体归并、时间过滤与请求明细联动', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-breakdown-'));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const geminiDir = join(sandbox, '.gemini');
  const agDir = join(geminiDir, 'antigravity');
  const convDir = join(agDir, 'conversations');
  const stateDir = join(sandbox, 'state');
  await mkdir(convDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const nowSec = Math.floor(Date.now() / 1000);
  const tenDaysAgoSec = nowSec - 10 * 86400;

  const convA1 = '11111111-1111-4111-8111-111111111111';
  const convA2 = '22222222-2222-4222-8222-222222222222';
  const convSub = '33333333-3333-4333-8333-333333333333';
  const convB1 = '44444444-4444-4444-8444-444444444444';
  const convOrphan = '55555555-5555-4555-8555-555555555555';

  createConvDb(join(convDir, `${convA1}.db`), [
    { model: 'gemini-3.8-flash', input: 1000, output: 500, cached: 4000, tsSec: nowSec - 120 },
  ]);
  createConvDb(join(convDir, `${convA2}.db`), [
    { model: 'gemini-2.5-flash', input: 2000, output: 1000, cached: 0, tsSec: nowSec - 60 },
  ]);
  createConvDb(join(convDir, `${convSub}.db`), [
    { model: 'gemini-3.8-flash', input: 500, output: 200, cached: 1000, tsSec: nowSec - 30 },
  ]);
  createConvDb(join(convDir, `${convB1}.db`), [
    { model: 'gemini-2.5-flash', input: 3000, output: 1000, cached: 0, tsSec: tenDaysAgoSec },
  ]);
  createConvDb(join(convDir, `${convOrphan}.db`), [
    { model: 'gemini-3.8-flash', input: 400, output: 100, cached: 0, tsSec: nowSec - 10 },
  ]);

  const sumDb = new DatabaseSync(join(agDir, 'conversation_summaries.db'));
  try {
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT,
        title TEXT,
        workspace_uris TEXT,
        project_id TEXT,
        parent_conversation_id TEXT,
        last_modified_time TEXT,
        step_count INTEGER
      );
      CREATE TABLE conversation_parents (
        conversation_id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL
      );
    `);
    const ins = sumDb.prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, project_id, parent_conversation_id, last_modified_time, step_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    ins.run(convA1, '主对话 A1', '["file:///f%3A/workspace/old-name"]', 'proj-a', '', '2026-11-20T08:00:00Z', 12);
    ins.run(convA2, '主对话 A2', '["file:///f%3A/workspace/new-name"]', 'proj-a', '', '2026-11-22T08:00:00Z', 8);
    ins.run(convSub, '', '["file:///f%3A/workspace/new-name"]', 'proj-a', convA1, '2026-11-22T08:05:00Z', 4);
    ins.run(convB1, '十天前对话 B1', '["file:///Users/demo/project-b"]', 'proj-b', '', '2026-11-10T08:00:00Z', 6);
  } finally {
    sumDb.close();
  }

  const mgr = new UsageStatsManager({ geminiDir, stateDir });
  const bdToday = await mgr.getUsageBreakdown('today', { force: true });

  assert.equal(bdToday.period, 'today');
  assert.equal(bdToday.projects.length, 2, '今日应包含 proj-a 与未归属项目，排除十天前的 proj-b');
  const projA = bdToday.projects.find(p => p.id === 'proj:proj-a');
  assert.ok(projA);
  assert.equal(projA.name, 'new-name', '同 project_id 重命名目录后应取最新目录名');
  assert.equal(projA.workspacePath, 'F:/workspace/new-name');
  assert.equal(projA.conversationCount, 2, '子智能体应合并入根对话，proj-a 下共 2 个根对话');
  assert.equal(projA.requestCount, 3);
  assert.equal(projA.totalTokens, 10200);

  const convA1Row = bdToday.conversations.find(c => c.id === convA1);
  assert.ok(convA1Row);
  assert.equal(convA1Row.title, '主对话 A1');
  assert.equal(convA1Row.subagentCount, 1);
  assert.deepEqual(convA1Row.dbFiles, [`${convA1}.db`, `${convSub}.db`].sort());
  assert.equal(convA1Row.totalTokens, 7200);
  assert.equal(convA1Row.requestCount, 2);

  const orphanRow = bdToday.conversations.find(c => c.id === convOrphan);
  assert.ok(orphanRow);
  assert.equal(orphanRow.projectId, '__unassigned__');
  assert.ok(orphanRow.title.includes(convOrphan.slice(0, 8)));

  const bdAll = await mgr.getUsageBreakdown('all');
  assert.equal(bdAll.projects.length, 3, '全部周期应包含 proj-b');
  assert.equal(bdAll.conversations.length, 4);

  const bdProjA = await mgr.getUsageBreakdown('all', { projectId: 'proj:proj-a' });
  assert.equal(bdProjA.projects.length, 3, '筛选 projectId 时仍保留完整项目列表用于切换');
  assert.equal(bdProjA.conversations.length, 2);
  assert.ok(bdProjA.conversations.every(c => c.projectId === 'proj:proj-a'));

  const convEvents = await mgr.getUsageEvents('all', '', 0, 50, bdAll.snapshotId, false, false, undefined, convA1Row.dbFiles);
  assert.equal(convEvents.total, 2);
  assert.equal(convEvents.rows.reduce((sum, r) => sum + r.total_tokens, 0), 7200);
});

test('ledgerBreakdownBuckets 在 SQLite 账本 Worker 模式下正确汇总各会话与模型桶', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-ledger-bd-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const dbPath = join(dir, 'ledger.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    db.exec(`
      CREATE TABLE events (event_key TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, account_id TEXT, model TEXT NOT NULL, payload TEXT NOT NULL, observed_at REAL NOT NULL DEFAULT 0);
      CREATE TABLE event_revisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL, timestamp INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE rate_locks (event_key TEXT PRIMARY KEY, unit_price TEXT NOT NULL, usd REAL NOT NULL);
      CREATE TABLE event_aliases (legacy_key TEXT PRIMARY KEY, event_key TEXT NOT NULL);
      CREATE TABLE rate_changes (version INTEGER PRIMARY KEY, min_event_seq INTEGER NOT NULL);
      CREATE TABLE snapshot_pins (snapshot_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, expires INTEGER NOT NULL);
    `);
    const e1 = {
      event_key: 'k1',
      model: 'gemini-3.8-flash',
      input_tokens: 1000,
      output_tokens: 500,
      cached_tokens: 2000,
      total_tokens: 3500,
      timestamp_seconds: now - 10,
      db_file: 'conv-1.db',
    };
    const e2 = {
      event_key: 'k2',
      model: 'gemini-3.8-flash',
      input_tokens: 500,
      output_tokens: 100,
      cached_tokens: 0,
      total_tokens: 600,
      timestamp_seconds: now - 5,
      db_file: 'conv-1.db',
    };
    db.prepare('INSERT INTO event_revisions(event_key, timestamp, payload) VALUES (?, ?, ?)').run('k1', e1.timestamp_seconds, JSON.stringify(e1));
    db.prepare('INSERT INTO event_revisions(event_key, timestamp, payload) VALUES (?, ?, ?)').run('k2', e2.timestamp_seconds, JSON.stringify(e2));
    db.prepare('INSERT INTO rate_locks VALUES (?, ?, ?)').run('k1', JSON.stringify({ input: 0.75, output: 3.75, cached: 0.075 }), 0.002775);
    db.prepare('INSERT INTO rate_locks VALUES (?, ?, ?)').run('k2', JSON.stringify({ input: 0.75, output: 3.75, cached: 0.075 }), 0.00075);
    db.prepare('INSERT INTO snapshot_pins VALUES (?, ?, ?)').run('snap-1', 2, Date.now() + 60000);

    const buckets = ledgerBreakdownBuckets(db, {
      snapshot: { revision: 2, generatedAt: now, accountId: 'all', rateRevision: 0, snapshotId: 'snap-1' },
      period: 'today',
    });
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].dbFile, 'conv-1.db');
    assert.equal(buckets[0].requestCount, 2);
    assert.equal(buckets[0].totalTokens, 4100);
    assert.ok(buckets[0].estimatedUsd > 0);
  } finally {
    db.close();
  }
});

test('IPC usage_breakdown 与 usage_events dbFiles 过滤契约在真实子进程中工作正常', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'gb-ipc-bd-'));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const stateDir = join(sandbox, 'state');
  const geminiDir = join(sandbox, 'gemini');
  const agDir = join(geminiDir, 'antigravity');
  const convDir = join(agDir, 'conversations');
  await mkdir(stateDir, { recursive: true });
  await mkdir(convDir, { recursive: true });

  const nowSec = Math.floor(Date.now() / 1000);
  const c1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const c2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  createConvDb(join(convDir, `${c1}.db`), [{ model: 'gemini-3.8-flash', input: 100, output: 50, cached: 0, tsSec: nowSec - 20 }]);
  createConvDb(join(convDir, `${c2}.db`), [{ model: 'gemini-2.5-flash', input: 300, output: 100, cached: 0, tsSec: nowSec - 10 }]);

  const sumDb = new DatabaseSync(join(agDir, 'conversation_summaries.db'));
  try {
    sumDb.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT, project_id TEXT, parent_conversation_id TEXT, last_modified_time TEXT, step_count INTEGER);');
    const ins = sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run(c1, 'IPC 对话一', '["file:///Users/demo/ipc-proj"]', 'p-ipc', '', '2026-11-22T09:00:00Z', 3);
    ins.run(c2, 'IPC 对话二', '["file:///Users/demo/ipc-proj"]', 'p-ipc', '', '2026-11-22T09:01:00Z', 5);
  } finally {
    sumDb.close();
  }

  const rpc = (payload) =>
    new Promise((resolve, reject) => {
      const socket = createConnection(controlEndpointForStateDir(stateDir));
      let raw = '';
      socket.setTimeout(8000, () => {
        socket.destroy();
        reject(new Error('IPC timeout'));
      });
      socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        raw += chunk;
        if (raw.includes('\n')) {
          socket.end();
          resolve(JSON.parse(raw.split('\n')[0]));
        }
      });
    });

  const child = spawn(
    process.execPath,
    [
      join(root, 'dist', 'main.js'),
      '--state-dir', stateDir,
      '--locale', 'zh-Hans',
      '--app', '/nonexistent',
      '--profile', join(sandbox, 'no-profile'),
      '--home-dir', sandbox,
      '--app-support-dir', sandbox,
      '--gemini-dir', geminiDir,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' } }
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const st = await rpc({ command: 'status' });
        if (st?.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 40));
    }

    const bd = await rpc({ command: 'usage_breakdown', period: 'today', force: true });
    assert.equal(bd.ok, true);
    assert.equal(bd.projects.length, 1);
    assert.equal(bd.projects[0].name, 'ipc-proj');
    assert.equal(bd.conversations.length, 2);

    const target = bd.conversations.find((c) => c.id === c1);
    assert.ok(target);
    const evs = await rpc({ command: 'usage_events', period: 'today', dbFiles: target.dbFiles, snapshotId: bd.snapshotId });
    assert.equal(evs.ok, true);
    assert.equal(evs.total, 1);
    assert.equal(evs.rows[0].total_tokens, 150);

    await rpc({ command: 'stop' });
    await Promise.race([closed, new Promise(r => setTimeout(r, 3000))]);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
});
