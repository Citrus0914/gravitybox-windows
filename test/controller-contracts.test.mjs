import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../dist/controller.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { controlEndpointForStateDir } from "../dist/platform/paths.js";

describeContractGroup("连接与控制 · optimization-20261022", { concurrency: false }, async () => {
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const fixture = async fn => {
    const dir = await mkdtemp(join(tmpdir(), 'gb-opt-'));
    try { return await fn(dir); }
    finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  };

  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }

  const rpc = (dir, p) => new Promise((resolve, reject) => {
    const s = createConnection(controlEndpointForStateDir(dir));
    let b = '';
    s.on('error', reject);
    s.on('connect', () => s.write(JSON.stringify(p) + '\n'));
    s.setTimeout(10000, () => { s.destroy(); reject(new Error('timeout')); });
    s.on('data', c => { b += c; if (b.includes('\n')) { s.end(); resolve(JSON.parse(b.split('\n')[0])); } });
  });

  async function ready(dir) {
    const ep = controlEndpointForStateDir(dir);
    for (let i = 0; i < 300; i++) {
      try {
        if (!ep.startsWith('\\\\.\\pipe\\')) await access(ep);
        await new Promise((res, rej) => {
          const s = createConnection(ep);
          s.once('connect', () => { s.destroy(); res(); });
          s.once('error', rej);
        });
        return;
      } catch {}
      await pause(20);
    }
    throw Error('backend not ready');
  }

  test('已暂停的 HUD 在重新启动时保持暂停，不注入目标应用', () => fixture(async dir => {
    await writeFile(join(dir, 'runtime-preferences.json'), JSON.stringify({ hudEnabled: false }));
    const child = spawn(
      process.execPath,
      ['dist/main.js', '--state-dir', dir, '--app', '/nonexistent', '--profile', dir, '--home-dir', dir, '--app-support-dir', dir, '--gemini-dir', dir],
      { stdio: 'ignore', env: { ...process.env } },
    );
    try {
      await ready(dir);
      let status;
      for (let i = 0; i < 100; i++) {
        status = await rpc(dir, { command: 'status', includeTasks: false });
        if (status.status.mode === 'paused') break;
        await pause(20);
      }
      assert.equal(status.status.mode, 'paused');
      assert.equal(status.status.windows, 0);
      assert.equal(status.status.hudEnabled, false);
    } finally {
      await stop(child);
    }
  }));

  test('P0-01/P1-31：Controller 状态与错误不含未解析 backend 前缀，切语种清空旧错误并串行收敛', async () => {
    const published = [];
    const c = new Controller({
      appPath: '/tmp/gravitybox-nonexistent-app.app',
      profile: '/tmp/gravitybox-nonexistent-profile',
      hudEnabled: false,
      locale: 'zh-Hans',
      configuredLanguage: 'zh-Hans',
      onStatus: (s) => published.push(structuredClone(s)),
    });
    try {
      assert.equal(c.status.message.includes('backend.status.'), false);
      assert.notEqual(c.status.message, 'status.starting');
      assert.equal(c.status.locale, 'zh-Hans');

      c.status.errors = ['残留的旧语种错误'];
      await c.setLocale('en', 'en');
      assert.equal(c.status.locale, 'en');
      assert.equal(c.status.mode, 'paused');
      assert.deepEqual(c.status.errors, []);
      assert.equal(c.status.message.includes('backend.status.'), false);
      assert.notEqual(c.status.message, 'status.paused');
      assert.equal(/[\u3400-\u9fff]/.test(c.status.message), false);

      await Promise.all([
        c.configureHud(false),
        c.setLocale('zh-Hans', 'zh-Hans'),
        c.setLocale('en', 'en'),
      ]);
      assert.equal(c.status.locale, 'en');
      assert.equal(c.status.mode, 'paused');
      assert.equal(published.every((s) => !s.message.includes('backend.status.')), true);
    } finally {
      await c.stop();
    }
  });
});
