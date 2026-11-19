import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAsciiCargoTargetDir } from '../tools/build-desktop.mjs';
import { isWindows } from '../dist/platform/fs.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('desktop/src-tauri 配置与前端产物契约校验', () => {
  const tauriConf = JSON.parse(readFileSync(join(root, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(tauriConf.productName, 'GravityBox');
  const winLabels = (tauriConf.app?.windows ?? []).map((w) => w.label);
  assert.deepEqual(winLabels.sort(), ['main', 'tray']);

  const cap = JSON.parse(
    readFileSync(join(root, 'desktop', 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
  );
  assert.ok(cap.windows.includes('main') && cap.windows.includes('tray'));
  assert.ok(cap.permissions.includes('core:window:allow-set-focus'));
  assert.equal(cap.permissions.includes('core:window:allow-focus'), false);

  const zhJson = JSON.parse(readFileSync(join(root, 'assets', 'i18n', 'zh-Hans.json'), 'utf8')).app;
  const enJson = JSON.parse(readFileSync(join(root, 'assets', 'i18n', 'en.json'), 'utf8')).app;
  for (const requiredKey of [
    'nav.overview',
    'nav.accounts',
    'nav.usage',
    'nav.settings',
    'nav.about',
    'overview.title',
    'accounts.title',
    'usage.title',
    'settings.title',
    'about.title',
    'sidebar.open_antigravity',
    'menu.quit',
  ]) {
    assert.ok(typeof zhJson[requiredKey] === 'string' && zhJson[requiredKey].length > 0, `缺少中文词条 ${requiredKey}`);
    assert.ok(typeof enJson[requiredKey] === 'string' && enJson[requiredKey].length > 0, `缺少英文词条 ${requiredKey}`);
  }
});

test('tools/build-desktop: resolveAsciiCargoTargetDir 始终返回纯 ASCII 路径', () => {
  const dir = resolveAsciiCargoTargetDir();
  assert.equal(/[^\x00-\x7F]/.test(dir), false, `CARGO_TARGET_DIR 不应包含非 ASCII 字符: ${dir}`);
});

test('desktop 前端构建产物与 Tauri 图标齐备', { skip: !isWindows }, () => {
  assert.equal(existsSync(join(root, 'desktop', 'dist', 'index.html')), true, '应先生成 desktop/dist/index.html');
  for (const iconName of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.ico']) {
    assert.equal(
      existsSync(join(root, 'desktop', 'src-tauri', 'icons', iconName)),
      true,
      `缺少 Tauri 图标 ${iconName}`,
    );
  }
});
