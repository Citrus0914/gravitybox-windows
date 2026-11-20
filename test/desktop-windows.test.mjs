import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveAsciiCargoTargetDir } from '../tools/build-desktop.mjs';
import { isWindows } from '../dist/platform/fs.js';
import { controlEndpointForStateDir } from '../dist/platform/paths.js';

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

test('desktop 生产构建启用 custom-protocol 嵌入 frontendDist', () => {
  const cargoToml = readFileSync(join(root, 'desktop', 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.match(cargoToml, /custom-protocol\s*=\s*\[\s*"tauri\/custom-protocol"\s*\]/);
  const buildDesktopSrc = readFileSync(join(root, 'tools', 'build-desktop.mjs'), 'utf8');
  assert.match(buildDesktopSrc, /custom-protocol/);
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

test('desktop/src/format: extractQuotaBars 兼容 ProjectedQuotaGroup 与旧式字段', async () => {
  const src = readFileSync(join(root, 'desktop', 'src', 'format.ts'), 'utf8');
  const transpiled = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(transpiled, 'utf8').toString('base64')}`);

  const t = (key, _params, fallback) => {
    if (key === 'common.period.5h') return '5h';
    if (key === 'common.period.weekly') return 'Weekly';
    if (key === 'common.period.daily') return 'Daily';
    return fallback ?? key;
  };

  const bars = mod.extractQuotaBars(
    {
      staleGroups: [{ name: 'claude', observed_at: 1700000000 }],
      quotaGroups: [
        {
          key: 'gemini',
          displayName: 'Gemini',
          brands: ['gemini'],
          availability: 'available',
          quotaState: 'known',
          windows: [
            { id: '5h', period: '5h', remaining: 0.82, known: true, resetCountdown: '3h 10m', stale: false },
            { id: 'weekly', period: 'weekly', remaining: 0.64, known: true, resetCountdown: '4d', stale: false },
          ],
        },
        {
          key: 'claude',
          displayName: 'Claude/GPT',
          brands: ['claude', 'gpt'],
          availability: 'available',
          quotaState: 'stale',
          windows: [
            { id: '5h', period: '5h', remaining: 0.15, known: true, resetCountdown: '1h', stale: true },
          ],
        },
        {
          key: 'argon',
          displayName: 'Gemini 4 Argon',
          brands: ['gemini'],
          availability: 'unavailable',
          quotaState: 'not_reported',
          windows: [],
        },
        {
          key: 'carbon',
          displayName: 'Gemini 4 Carbon',
          brands: ['gemini'],
          availability: 'available',
          quotaState: 'not_reported',
          windows: [
            { id: 'model', period: 'unspecified', remaining: null, known: false, stale: false },
          ],
        },
      ],
    },
    t,
  );

  assert.equal(bars.length, 4);
  assert.deepEqual(bars[0], {
    key: 'gemini:5h',
    label: 'Gemini · 5h',
    family: 'gemini',
    percentage: 82,
    resetCountdown: '3h 10m',
    stale: false,
  });
  assert.equal(bars[1].percentage, 64);
  assert.equal(bars[2].family, 'claude');
  assert.equal(bars[2].percentage, 15);
  assert.equal(bars[2].stale, true);
  assert.equal(bars[3].label, 'Gemini 4 Carbon');
  assert.equal(bars[3].percentage, null);

  const legacyBars = mod.extractQuotaBars(
    {
      geminiFiveHourRemaining: 90,
      geminiFiveHourResetCountdown: '4h',
      claudeWeeklyRemaining: 45,
      claudeWeeklyResetCountdown: '2d',
    },
    t,
  );
  assert.equal(legacyBars.length, 2);
  assert.equal(legacyBars[0].percentage, 90);
  assert.equal(legacyBars[1].percentage, 45);

  assert.equal(mod.statusColorForMode('adaptive', true), 'green');
  assert.equal(mod.statusColorForMode('waiting-window', true), 'amber');
  assert.equal(mod.statusColorForMode('legacy-blocked', true), 'amber');
  assert.equal(mod.formatStatusLabel({ mode: 'adaptive', translationEnabled: true }, true, 'zh-Hans', t), 'status.connected');
  assert.equal(mod.formatStatusLabel({ mode: 'adaptive', translationEnabled: false }, true, 'zh-Hans', t), 'status.connected_english');
  assert.equal(mod.formatStatusLabel({ mode: 'paused', locale: 'en', windows: 1 }, true, 'en', t), 'status.connected_english');
  assert.equal(mod.formatStatusLabel({ mode: 'waiting-window' }, true, 'zh-Hans', t), 'status.waiting_window');
  assert.equal(mod.formatStatusLabel({ mode: 'legacy-blocked' }, true, 'zh-Hans', t), 'status.legacy_blocked');
});

test('tools/win-installer.nsi 与 CI windows-desktop 门禁契约完整', () => {
  const nsi = readFileSync(join(root, 'tools', 'win-installer.nsi'), 'utf8');
  for (const token of ['APP_VERSION', 'STAGE_DIR', 'OUT_FILE', 'Uninstall\\GravityBox', 'RequestExecutionLevel user']) {
    assert.ok(nsi.includes(token), `NSIS 脚本缺少 ${token}`);
  }
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.includes('windows-desktop:'), 'ci.yml 应包含 windows-desktop job');
  assert.ok(ci.includes('needs.windows-desktop.result'), 'ci-gate 应校验 windows-desktop 结果');
});

function sendPipeCommand(pipePath, payload, timeoutMs = 8000) {
  return new Promise((resolveReply, reject) => {
    const client = createConnection(pipePath);
    let buf = '';
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`Pipe request timed out: ${payload.command}`));
    }, timeoutMs);
    client.on('connect', () => {
      client.write(JSON.stringify(payload) + '\n');
    });
    client.on('data', (chunk) => {
      buf += decoder.write(chunk);
      if (buf.includes('\n')) {
        clearTimeout(timer);
        client.end();
        try {
          resolveReply(JSON.parse(buf.split('\n')[0]));
        } catch (err) {
          reject(err);
        }
      }
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForPipePing(pipePath, deadlineMs = 15000, child = null, getStderr = null) {
  const deadline = Date.now() + deadlineMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const stderr = getStderr ? getStderr() : '';
      throw new Error(
        `Backend exited early (code=${child.exitCode}, signal=${child.signalCode}): ${stderr || '<no stderr>'}`,
      );
    }
    try {
      const res = await sendPipeCommand(pipePath, { command: 'ping' }, 1500);
      if (res?.ok) return res;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const stderr = getStderr ? getStderr() : '';
  const baseMsg = lastErr?.message || 'Timed out waiting for Windows Named Pipe';
  throw new Error(stderr ? `${baseMsg} (stderr: ${stderr})` : baseMsg);
}

test('Windows Named Pipe 后端 IPC 实机契约闭环', { skip: !isWindows }, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'gb-desktop-ipc-'));
  const stateDir = join(sandbox, 'state');
  const geminiDir = join(sandbox, 'gemini');
  const homeDir = join(sandbox, 'home');
  const appSupportDir = join(sandbox, 'app-support');
  const profileDir = join(sandbox, 'ag-profile');
  const appDir = join(sandbox, 'ag-app-missing');
  for (const d of [stateDir, geminiDir, homeDir, appSupportDir, profileDir]) {
    mkdirSync(d, { recursive: true });
  }
  const pipePath = controlEndpointForStateDir(stateDir);
  const child = spawn(
    process.execPath,
    [
      join(root, 'dist', 'main.js'),
      '--state-dir',
      stateDir,
      '--gemini-dir',
      geminiDir,
      '--home-dir',
      homeDir,
      '--app-support-dir',
      appSupportDir,
      '--profile',
      profileDir,
      '--app',
      appDir,
    ],
    {
      cwd: root,
      env: { ...process.env, GRAVITYBOX_CONTROL_ENDPOINT: pipePath, GRAVITYBOX_PROBE_LS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch {}
    }
  });

  const pingRes = await waitForPipePing(pipePath, 15000, child, () => stderr);
  assert.equal(pingRes.ok, true);
  assert.equal(typeof pingRes.pid, 'number');

  const statusRes = await sendPipeCommand(pipePath, {
    command: 'status',
    includeTasks: true,
    includeAccounts: true,
  });
  assert.equal(statusRes.ok, true);
  assert.ok(statusRes.status && typeof statusRes.status === 'object');

  const dashRes = await sendPipeCommand(pipePath, { command: 'dashboard_summary' });
  assert.equal(dashRes.ok, true);
  assert.ok(dashRes.accounts && typeof dashRes.accounts === 'object');
  assert.ok(dashRes.usage && typeof dashRes.usage === 'object');

  const accRes = await sendPipeCommand(pipePath, { command: 'account_list' });
  assert.equal(accRes.ok, true);
  assert.equal(Array.isArray(accRes.accounts), true);

  const policyGet = await sendPipeCommand(pipePath, { command: 'auto_switch_get' });
  assert.equal(policyGet.ok, true);
  assert.equal(policyGet.config.monitored_model, 'all');
  assert.equal(typeof policyGet.config.reserve_percentage, 'number');
  assert.equal(typeof policyGet.config.candidate_min_percentage, 'number');

  const policySet = await sendPipeCommand(pipePath, {
    command: 'auto_switch_set',
    config: {
      enabled: true,
      strategy: 'round_robin',
      monitored_model: 'gemini_all',
      reserve_percentage: 15,
      candidate_min_percentage: 40,
    },
  });
  assert.equal(policySet.ok, true);
  assert.equal(policySet.config.enabled, true);
  assert.equal(policySet.config.strategy, 'round_robin');
  assert.equal(policySet.config.monitored_model, 'gemini_all');
  assert.equal(policySet.config.reserve_percentage, 15);
  assert.equal(policySet.config.candidate_min_percentage, 40);

  const pricingRes = await sendPipeCommand(pipePath, { command: 'api_pricing_get' });
  assert.equal(pricingRes.ok, true);
  assert.ok(pricingRes.prices && typeof pricingRes.prices === 'object');
  const firstPrice = Object.values(pricingRes.prices)[0];
  assert.ok(firstPrice && typeof firstPrice.input === 'number' && typeof firstPrice.output === 'number');

  const usageRes = await sendPipeCommand(pipePath, { command: 'usage_summary', period: 'today' });
  assert.equal(usageRes.ok, true);
  assert.ok(usageRes.summary && typeof usageRes.summary === 'object');

  const maintRes = await sendPipeCommand(pipePath, { command: 'maintenance_scan', retentionDays: 7 });
  assert.equal(maintRes.ok, true);
  assert.ok(maintRes.buckets?.runtimeCache);

  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
  });
  const stopRes = await sendPipeCommand(pipePath, { command: 'stop' });
  assert.equal(stopRes.ok, true);
  const exitCode = await exitPromise;
  assert.equal(exitCode, 0);
});

test('Windows verbatim \\\\?\\ 路径启动 dist/main.js 仍可正常识别为主入口', { skip: !isWindows }, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'gb-verbatim-entry-'));
  const stateDir = join(sandbox, 'state');
  const geminiDir = join(sandbox, 'gemini');
  const homeDir = join(sandbox, 'home');
  const appSupportDir = join(sandbox, 'app-support');
  const profileDir = join(sandbox, 'ag-profile');
  const appDir = join(sandbox, 'ag-app-missing');
  for (const d of [stateDir, geminiDir, homeDir, appSupportDir, profileDir]) {
    mkdirSync(d, { recursive: true });
  }
  const pipePath = controlEndpointForStateDir(stateDir);
  const realEntry = join(root, 'dist', 'main.js');
  const verbatimEntry = `\\\\?\\${realEntry}`;
  // Node 22 在 CLI 直接传入 \\?\ 入口路径时会在内部 cjs/loader realpathSync 阶段触发 EISDIR lstat 'D:'；
  // 通过独立进程注入 verbatim process.argv[1] 后导入真实入口，可在 Node 22+ 稳定验证 src/main.ts 的 normalizeEntryPath 剥离逻辑。
  const bootstrap =
    "import { pathToFileURL } from 'node:url'; " +
    'process.argv = [process.execPath, process.env.GB_VERBATIM_ENTRY, ...process.argv.slice(1)]; ' +
    'await import(pathToFileURL(process.env.GB_REAL_ENTRY).href);';
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      bootstrap,
      '--',
      '--state-dir',
      stateDir,
      '--gemini-dir',
      geminiDir,
      '--home-dir',
      homeDir,
      '--app-support-dir',
      appSupportDir,
      '--profile',
      profileDir,
      '--app',
      appDir,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GB_REAL_ENTRY: realEntry,
        GB_VERBATIM_ENTRY: verbatimEntry,
        GRAVITYBOX_CONTROL_ENDPOINT: pipePath,
        GRAVITYBOX_PROBE_LS: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch {}
    }
  });

  const pingRes = await waitForPipePing(pipePath, 15000, child, () => stderr);
  assert.equal(pingRes.ok, true);
  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
  });
  const stopRes = await sendPipeCommand(pipePath, { command: 'stop' });
  assert.equal(stopRes.ok, true);
  assert.equal(await exitPromise, 0);
});

test('desktop 用量页导出使用原生 Tauri save_json_file 而非 WebView2 失效的 Blob 下载', () => {
  const usagePageSrc = readFileSync(join(root, 'desktop', 'src', 'pages', 'UsagePage.tsx'), 'utf8');
  assert.equal(usagePageSrc.includes('URL.createObjectURL'), false, '不应在 WebView2 中使用失效的 Blob/a.download 导出');
  assert.ok(usagePageSrc.includes('saveJsonFile'), 'UsagePage 应调用 saveJsonFile');
  const ipcSrc = readFileSync(join(root, 'desktop', 'src', 'ipc.ts'), 'utf8');
  assert.ok(ipcSrc.includes("'save_json_file'"), 'ipc.ts 应封装 save_json_file 命令');
  const mainRs = readFileSync(join(root, 'desktop', 'src-tauri', 'src', 'main.rs'), 'utf8');
  assert.ok(mainRs.includes('fn save_json_file'), 'main.rs 应定义 save_json_file 命令');
  assert.ok(mainRs.includes('save_json_file,'), 'main.rs 应在 invoke_handler 中注册 save_json_file');
});
