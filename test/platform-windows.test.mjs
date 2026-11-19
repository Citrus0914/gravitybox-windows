import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { BundleCache } from '../dist/bundle-cache.js';
import { nativeSources } from '../dist/coverage.js';
import { isOwnedByCurrentUser, isWindows } from '../dist/platform/fs.js';
import {
  bundleLayoutPaths,
  controlEndpointForStateDir,
  defaultApplicationsDir,
  defaultAppPath,
  defaultCacheDir,
  defaultProfileDir,
  defaultStateDir,
  isNamedPipeEndpoint,
} from '../dist/platform/paths.js';
import { decodeKeyringPayload, SystemKeychainAdapter, syncAccountToKeychain } from '../dist/account-keychain.js';
import { winExeInfo, winPsList } from '../dist/platform/win-helper.js';

test('platform/paths: Windows 路径与命名管道解析正确且隔离自定义 home', () => {
  const endpoint = controlEndpointForStateDir('C:\\Users\\Test\\AppData\\Local\\GravityBox');
  if (isWindows) {
    assert.equal(isNamedPipeEndpoint(endpoint), true);
    assert.match(endpoint, /^\\\\\.\\pipe\\gravitybox-[0-9a-f]{16}$/);
    assert.equal(
      controlEndpointForStateDir('c:/users/test/appdata/local/gravitybox'),
      endpoint,
      'Windows 命名管道哈希对大小写与正反斜杠归一化一致',
    );
    assert.equal(defaultApplicationsDir('C:\\SyntheticHome'), 'C:\\SyntheticHome\\AppData\\Local\\Programs');
    assert.equal(defaultAppPath('C:\\SyntheticHome'), 'C:\\SyntheticHome\\AppData\\Local\\Programs\\Antigravity');
    assert.equal(defaultProfileDir('C:\\SyntheticHome'), 'C:\\SyntheticHome\\AppData\\Roaming\\Antigravity');
    assert.equal(defaultStateDir('C:\\SyntheticHome'), 'C:\\SyntheticHome\\AppData\\Local\\GravityBox');
    assert.equal(defaultCacheDir('C:\\SyntheticHome'), 'C:\\SyntheticHome\\AppData\\Local\\GravityBox\\Cache');
    const winLayout = bundleLayoutPaths('C:\\Apps\\Antigravity');
    assert.equal(winLayout.executablePath, 'C:\\Apps\\Antigravity\\Antigravity.exe');
    assert.equal(winLayout.asarPath, 'C:\\Apps\\Antigravity\\resources\\app.asar');
  } else {
    assert.equal(isNamedPipeEndpoint(endpoint), false);
    assert.equal(endpoint, join('C:\\Users\\Test\\AppData\\Local\\GravityBox', 'control.sock'));
  }

  const macLayout = bundleLayoutPaths('/Applications/Antigravity.app');
  assert.equal(macLayout.asarPath, join('/Applications/Antigravity.app', 'Contents', 'Resources', 'app.asar'));
});

test('platform/fs: isOwnedByCurrentUser 在当前进程文件上返回 true', async () => {
  const st = await lstat(process.execPath);
  assert.equal(isOwnedByCurrentUser(st), true);
});

test('decodeKeyringPayload 同时兼容 macOS go-keyring-base64 与 Windows 原生 UTF-8 JSON', () => {
  const sample = { token: { refresh_token: 'ref', email: 'u@example.test' }, id_token_email: 'u@example.test' };
  const rawJson = JSON.stringify(sample);
  const b64 = `go-keyring-base64:${Buffer.from(rawJson, 'utf8').toString('base64')}`;
  assert.deepEqual(decodeKeyringPayload(rawJson), sample);
  assert.deepEqual(decodeKeyringPayload(b64), sample);
  assert.equal(decodeKeyringPayload('not-json'), null);
  assert.equal(decodeKeyringPayload(null), null);
});

test('Windows 原生辅助程序: WinCred 读写删、PE 签名元数据与进程列表', { skip: !isWindows }, async () => {
  const info = await winExeInfo(process.execPath);
  assert.ok(info.fileVersion.length > 0, '应能读取 node.exe PE 版本号');
  assert.equal(typeof info.signed, 'boolean');

  const procs = await winPsList();
  assert.ok(procs.some(p => p.pid === process.pid), '进程列表应包含当前 node 测试进程');

  const adapter = new SystemKeychainAdapter();
  const service = 'gravitybox-unit-test';
  const account = `rt-${process.pid}-${Date.now()}`;
  const secret = JSON.stringify({ token: { access_token: 'a', refresh_token: 'r' }, email: 't@example.test' });
  await adapter.deletePassword(service, account);
  assert.equal(await adapter.readPassword(service, account), null);
  await adapter.writePassword(service, account, secret);
  assert.equal(await adapter.readPassword(service, account), secret);
  await adapter.deletePassword(service, account);
  assert.equal(await adapter.readPassword(service, account), null);

  // syncAccountToKeychain 在 Windows 上应写出纯 JSON
  let captured = '';
  await syncAccountToKeychain(
    {
      email: 'win@example.test',
      token: { access_token: 'at', refresh_token: 'rt', expiry_timestamp: Math.floor(Date.now() / 1000) + 3600 },
    },
    {
      readPassword: async () => null,
      deletePassword: async () => {},
      writePassword: async (_s, _a, value) => { captured = value; },
    },
  );
  assert.equal(captured.startsWith('{'), true);
  assert.equal(decodeKeyringPayload(captured)?.token?.email, 'win@example.test');
});

test('Windows 解包目录布局: BundleCache 与 nativeSources 兼容 resources/app 无需 Contents/Resources/app.asar', { skip: !isWindows }, async (t) => {
  const appDir = await mkdtemp(join(tmpdir(), 'gb-win-unpacked-'));
  t.after(async () => {
    await rm(appDir, { recursive: true, force: true });
  });
  await mkdir(join(appDir, 'resources', 'app', 'dist'), { recursive: true });
  await writeFile(join(appDir, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.33.0' }));
  await writeFile(join(appDir, 'resources', 'app', 'dist', 'main.js'), 'console.log("Settings");');

  let reads = 0;
  const cache = new BundleCache();
  const fetcher = async () => ({ hash: `h-${++reads}`, source: 'body', bytes: 4 });
  const first = await cache.read(appDir, 100, '2.33.0', 'http://127.0.0.1:5191', fetcher);
  assert.equal(first.cacheHit, false);
  const second = await cache.read(appDir, 100, '2.33.0', 'http://127.0.0.1:5191', fetcher);
  assert.equal(second.cacheHit, true);
  assert.equal(reads, 1);

  await writeFile(join(appDir, 'resources', 'app', 'dist', 'main.js'), 'console.log("Settings Updated");');
  const third = await cache.read(appDir, 100, '2.33.0', 'http://127.0.0.1:5191', fetcher);
  assert.equal(third.cacheHit, false);
  assert.equal(reads, 2);

  const sources = await nativeSources(appDir);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'app.asar/dist/main.js');
  assert.match(sources[0].source, /Settings Updated/);
});
