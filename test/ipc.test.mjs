import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlEndpointForStateDir } from '../dist/platform/paths.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(30);
  }
  throw new Error('测试等待超时');
}
function rpc(directory, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlEndpointForStateDir(directory));
    let value = '';
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('IPC 超时')); });
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      value += chunk;
      if (value.includes('\n')) { socket.end(); resolve(JSON.parse(value.split('\n')[0])); }
    });
  });
}

test('真实后台返回 usage 汇总并拒绝已撤下的词典、账号与配额入口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-ipc-current-'));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../dist/main.js', import.meta.url)), '--state-dir', directory, '--app', '/nonexistent', '--profile', join(directory, 'no-profile'), '--gemini-dir', join(directory, 'gemini')],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env } },
  );
  const closed = new Promise(resolve => child.once('close', resolve));
  let errors = '';
  child.stderr.on('data', b => errors += b);
  try {
    await until(async () => { try { return (await rpc(directory, { command: 'status' })).ok; } catch { return false; } });
    const summary = await rpc(directory, { command: 'dashboard_summary' });
    assert.equal(summary.ok, true);
    assert.ok(summary.usage && typeof summary.usage === 'object');
    for (const command of ['dictionary_set', 'translation_set', 'account_list', 'quota_refresh', 'shortcut_set']) {
      assert.equal((await rpc(directory, { command })).ok, false, `${command} must stay unavailable`);
    }
    assert.equal(errors, '');
    await rpc(directory, { command: 'stop' });
    await until(() => child.exitCode === 0);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
