import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDesktop, resolveAsciiCargoTargetDir } from './build-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function runCmd(cmd, args, cwd = root, extraEnv = {}) {
  const isWin = process.platform === 'win32';
  const useCmdWrapper = isWin && (cmd === 'npm' || cmd === 'pnpm');
  const executable = useCmdWrapper ? (process.env.ComSpec || 'cmd.exe') : cmd;
  const finalArgs = useCmdWrapper ? ['/d', '/s', '/c', `${cmd}.cmd`, ...args] : args;
  execFileSync(executable, finalArgs, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function step(label, fn) {
  const started = performance.now();
  process.stdout.write(`\n[verify:win] ▶ ${label}\n`);
  fn();
  const sec = ((performance.now() - started) / 1000).toFixed(2);
  process.stdout.write(`[verify:win] ✅ ${label} (${sec}s)\n`);
}

export async function verifyWindows() {
  if (process.platform !== 'win32') {
    throw new Error('tools/verify-win.mjs must be run on Windows');
  }

  const totalStart = performance.now();

  step('Privacy Gate', () => {
    runCmd(process.execPath, [join(root, 'tools', 'check-privacy.mjs')]);
  });

  step('Source Docs Consistency', () => {
    runCmd(process.execPath, [join(root, 'tools', 'check-docs.mjs'), '--source-only']);
  });

  step('Backend TypeScript & Win32 Helper Build', () => {
    runCmd('npm', ['run', 'build']);
    const helperManifest = join(root, 'native-win', 'gb-win-helper', 'Cargo.toml');
    if (existsSync(helperManifest)) {
      runCmd('cargo', ['build', '--release', '--manifest-path', helperManifest], root, {
        CARGO_HTTP_MULTIPLEXING: 'false',
      });
      runCmd(process.execPath, [join(root, 'tools', 'copy-runtime.mjs')]);
    }
  });

  step('Tauri Rust Unit Tests', () => {
    const cargoTargetDir = resolveAsciiCargoTargetDir();
    mkdirSync(cargoTargetDir, { recursive: true });
    runCmd(
      'cargo',
      ['test', '--manifest-path', join(root, 'desktop', 'src-tauri', 'Cargo.toml')],
      join(root, 'desktop'),
      {
        CARGO_TARGET_DIR: cargoTargetDir,
        CARGO_HTTP_MULTIPLEXING: 'false',
      },
    );
  });

  step('Desktop Frontend & Tauri Shell Build', () => {
    buildDesktop({ release: true, skipBackend: true });
  });

  step('Fast Unit & Integration Tests', () => {
    runCmd(process.execPath, [join(root, 'tools', 'run-tests.mjs'), '--fast']);
  });

  step('Dictionary Gates (No Vendor)', () => {
    runCmd(process.execPath, [join(root, 'tools', 'verify.mjs'), '--dict-only', '--no-vendor']);
  });

  const totalSec = ((performance.now() - totalStart) / 1000).toFixed(2);
  process.stdout.write(`\n✅ All Windows verification gates passed in ${totalSec}s\n`);
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyWindows().catch((err) => {
    process.stderr.write(`❌ verify:win failed: ${err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
}
