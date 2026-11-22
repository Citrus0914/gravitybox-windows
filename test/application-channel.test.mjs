import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import {
  applicationChannel,
  savedApplicationChannel,
  allApplicationTargets,
  applicationTarget,
  channelStateDirectory,
  detectInstalledChannels,
  probeBundleCapabilities,
  targetForApp,
} from '../dist/application-target.js';
import { controlEndpointForStateDir, defaultAppBundleName, defaultProfileDir } from '../dist/platform/paths.js';
import { UsageStatsManager } from '../dist/usage.js';

const temporary = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-channel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('仅正式版可作为运行目标，旧持久配置可迁移而显式 Insiders 请求失败', () => {
  assert.equal(applicationChannel(undefined), 'stable');
  assert.equal(savedApplicationChannel('insiders'), 'stable');
  assert.throws(() => applicationChannel('preview'));
  assert.throws(() => applicationChannel('insiders'), /仅支持/);
  assert.throws(() => applicationTarget('insiders'), /仅支持/);
  assert.throws(() => targetForApp('/Applications/Antigravity - Insiders.app'), /仅支持/);
  assert.throws(() => applicationTarget('stable', undefined, { profile: '/tmp/Antigravity - Insiders' }), /仅支持/);
  const stable = applicationTarget('stable', '/synthetic-home');
  assert.equal(stable.bundleId, 'com.google.antigravity');
  assert.equal(stable.profile, defaultProfileDir('/synthetic-home'));
  assert.equal(channelStateDirectory('/state', 'stable'), '/state');
  assert.equal(allApplicationTargets().length, 1);
});

test('只发现正式版，不向仅安装的 Insiders 回落；保留正式版 WCV 架构兼容', async t => {
  const appsDir = await temporary(t);
  const stableDirName = defaultAppBundleName();
  const insidersDirName = stableDirName.endsWith('.app') ? 'Antigravity - Insiders.app' : 'Antigravity - Insiders';
  await mkdir(join(appsDir, stableDirName, 'Contents', 'Resources'), { recursive: true });
  const onlyStable = detectInstalledChannels('stable', appsDir);
  assert.equal(onlyStable.bothInstalled, false);
  assert.deepEqual(onlyStable.channels, ['stable']);
  assert.equal(onlyStable.effectiveChannel, 'stable');

  await mkdir(join(appsDir, insidersDirName, 'Contents', 'Resources'), { recursive: true });
  const both = detectInstalledChannels('stable', appsDir);
  assert.equal(both.bothInstalled, false);
  assert.deepEqual(both.channels, ['stable']);
  assert.equal(both.effectiveChannel, 'stable');

  await rm(join(appsDir, stableDirName), { recursive: true, force: true });
  const onlyInsiders = detectInstalledChannels('stable', appsDir);
  assert.equal(onlyInsiders.bothInstalled, false);
  assert.deepEqual(onlyInsiders.channels, []);
  assert.equal(onlyInsiders.effectiveChannel, 'stable');

  const futureStableApp = join(appsDir, 'Antigravity.app');
  await mkdir(join(futureStableApp, 'Contents', 'Resources'), { recursive: true });
  const pkgJson = Buffer.from(JSON.stringify({ version: '2.29.0', productName: 'Antigravity' }), 'utf8');
  const headerObj = {
    files: {
      'package.json': { size: pkgJson.length, offset: '0' },
      dist: { files: { 'wcvBrowserRegistry.js': { size: 10, offset: String(pkgJson.length) } } },
    },
  };
  const headerBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const alignedHeaderSize = Math.ceil((headerBuf.length + 4) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(alignedHeaderSize + 4, 4);
  prefix.writeUInt32LE(alignedHeaderSize, 8);
  prefix.writeUInt32LE(headerBuf.length, 12);
  const paddedHeader = Buffer.alloc(alignedHeaderSize - 4);
  headerBuf.copy(paddedHeader, 0);
  await writeFile(join(futureStableApp, 'Contents', 'Resources', 'app.asar'), Buffer.concat([prefix, paddedHeader, pkgJson]));

  const futureCaps = probeBundleCapabilities(futureStableApp, 'stable');
  assert.equal(futureCaps.architecture, 'wcv-hub');
  assert.equal(futureCaps.dataDirectoryName, 'antigravity');
});

test('仅统计正式版会话库，排除 Insiders、备份、IDE 和符号链接', async t => {
  const root = await temporary(t);
  for (const name of ['antigravity', 'antigravity-insiders', 'antigravity-backup', 'antigravity-ide']) {
    await mkdir(join(root, name, 'conversations'), { recursive: true });
    await writeFile(join(root, name, 'conversations', 'same.db'), 'synthetic');
    await writeFile(join(root, name, 'token_usage_archive.db'), 'synthetic');
  }
  try {
    await symlink(join(root, 'antigravity-backup', 'conversations', 'same.db'), join(root, 'antigravity-insiders', 'conversations', 'linked.db'));
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
  }

  const unifiedManager = new UsageStatsManager({ geminiDir: root, stateDir: root });
  const unifiedPaths = await unifiedManager.discoverDatabaseFiles();
  assert.deepEqual(
    unifiedPaths.sort(),
    [
      join(root, 'antigravity', 'conversations', 'same.db'),
      join(root, 'antigravity', 'token_usage_archive.db'),
    ].sort(),
  );

  const manager = new UsageStatsManager({ geminiDir: root, stateDir: root, dataDirectoryName: 'antigravity' });
  const paths = await manager.discoverDatabaseFiles();
  assert.deepEqual(paths.sort(), [join(root, 'antigravity', 'conversations', 'same.db'), join(root, 'antigravity', 'token_usage_archive.db')].sort());
  assert.throws(() => new UsageStatsManager({ stateDir: root, dataDirectoryName: 'antigravity-insiders' }), /仅统计/);
});

function request(socket, command) {
  return new Promise((resolve, reject) => {
    const client = createConnection(socket);
    let data = '';
    client.setTimeout(4000, () => client.destroy(new Error('fixture timeout')));
    client.on('connect', () => client.write(JSON.stringify(command) + '\n'));
    client.on('data', b => {
      data += b;
      if (data.includes('\n')) {
        client.end();
        resolve(JSON.parse(data.split('\n')[0]));
      }
    });
    client.on('error', reject);
  });
}

test('IPC 将旧 Insiders 配置备份后迁移到正式版，拒绝通道切换', { timeout: 15000 }, async t => {
  const state = await temporary(t);
  await mkdir(join(state, 'profile'));
  await writeFile(join(state, 'config.json'), JSON.stringify({ applicationChannel: 'insiders', futureSetting: 'preserve' }));
  const child = spawn(
    process.execPath,
    ['dist/main.js', '--state-dir', state, '--profile', join(state, 'profile'), '--gemini-dir', join(state, 'gemini')],
    { env: { ...process.env }, stdio: 'ignore' },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  const socket = controlEndpointForStateDir(state);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await request(socket, { command: 'ping' }); ready = true; break; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  assert.equal(ready, true);

  const status = await request(socket, { command: 'status' });
  assert.equal(status.status.applicationLabel, 'Antigravity');
  assert.equal(status.status.applicationChannel, 'stable');
  assert.equal(status.status.bothApplicationsInstalled, false);

  const persisted = JSON.parse(await readFile(join(state, 'config.json'), 'utf8'));
  assert.equal(persisted.applicationChannel, 'stable');
  assert.equal(persisted.futureSetting, 'preserve');
  const backup = JSON.parse(await readFile(join(state, 'config-before-stable-only.json'), 'utf8'));
  assert.equal(backup.applicationChannel, 'insiders');

  const rejected = await request(socket, { command: 'set_application_channel', channel: 'insiders' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /仅支持/);

  const beforePid = status.status.pid;
  const switched = await request(socket, { command: 'set_application_channel', channel: 'stable' });
  assert.equal(switched.ok, true);
  assert.equal(switched.applicationLabel, 'Antigravity');

  const statusAfter = await request(socket, { command: 'status' });
  assert.equal(statusAfter.status.pid, beforePid);

  await request(socket, { command: 'stop' });
  if (child.exitCode === null) await once(child, 'exit');
});
