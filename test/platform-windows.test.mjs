import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
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

test('Windows 原生辅助程序: PE 签名元数据与进程列表', { skip: !isWindows }, async () => {
  const info = await winExeInfo(process.execPath);
  assert.ok(info.fileVersion.length > 0, '应能读取 node.exe PE 版本号');
  assert.equal(typeof info.signed, 'boolean');

  const procs = await winPsList();
  assert.ok(procs.some(p => p.pid === process.pid), '进程列表应包含当前 node 测试进程');
});
