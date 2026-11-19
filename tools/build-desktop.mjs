import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktopDir = join(root, 'desktop');
const tauriManifest = join(desktopDir, 'src-tauri', 'Cargo.toml');

export function warnIfLowIntegrityDir(dirPath) {
  if (process.platform !== 'win32' || !dirPath || !existsSync(dirPath)) return;
  try {
    const acl = execFileSync('icacls', [dirPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (/Low Mandatory Level/i.test(acl)) {
      process.stdout.write(
        `⚠️ Output directory carries Windows Low Mandatory Level (${dirPath}); ` +
          'Tauri/WebView2 GUI binaries cannot initialize from a Low-Integrity drive (0xC0000142). ' +
          'Extract the .zip package to a normal Medium-Integrity directory (e.g. %LocalAppData%\\Programs\\GravityBox) before launching.\n',
      );
    }
  } catch {
    // ignore
  }
}

export function resolveAsciiCargoTargetDir() {
  if (process.env.CARGO_TARGET_DIR && !/[^\x00-\x7F]/.test(process.env.CARGO_TARGET_DIR)) {
    return process.env.CARGO_TARGET_DIR;
  }
  if (/[^\x00-\x7F]/.test(root)) {
    const baseTmp = tmpdir();
    if (!/[^\x00-\x7F]/.test(baseTmp)) {
      return join(baseTmp, 'gravitybox-desktop-target');
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData && !/[^\x00-\x7F]/.test(localAppData)) {
      return join(localAppData, 'Temp', 'gravitybox-desktop-target');
    }
    return 'C:\\Windows\\Temp\\gravitybox-desktop-target';
  }
  return join(desktopDir, 'src-tauri', 'target');
}

function runSync(cmd, args, cwd, extraEnv = {}) {
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

export function buildDesktop({ release = true, skipBackend = false } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('tools/build-desktop.mjs is intended for Windows builds');
  }

  if (!skipBackend) {
    runSync('npm', ['run', 'build'], root);
    const helperManifest = join(root, 'native-win', 'gb-win-helper', 'Cargo.toml');
    if (existsSync(helperManifest)) {
      runSync('cargo', ['build', '--release', '--manifest-path', helperManifest], root, {
        CARGO_HTTP_MULTIPLEXING: 'false',
      });
      // Re-run copy-runtime so dist/gb-win-helper.exe is always up to date
      runSync('node', [join(root, 'tools', 'copy-runtime.mjs')], root);
    }
  }

  const pnpmCmd = existsSync(join(desktopDir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
  runSync(pnpmCmd, ['run', 'build'], desktopDir);

  const cargoTargetDir = resolveAsciiCargoTargetDir();
  mkdirSync(cargoTargetDir, { recursive: true });
  const cargoArgs = ['build', '--manifest-path', tauriManifest];
  if (release) cargoArgs.push('--release');

  runSync('cargo', cargoArgs, desktopDir, {
    CARGO_TARGET_DIR: cargoTargetDir,
    CARGO_HTTP_MULTIPLEXING: 'false',
  });

  const profileDir = join(cargoTargetDir, release ? 'release' : 'debug');
  const exeSrc = join(profileDir, 'gravitybox-desktop.exe');
  const loaderSrc = join(profileDir, 'WebView2Loader.dll');
  if (!existsSync(exeSrc)) {
    throw new Error(`Expected built binary not found: ${exeSrc}`);
  }

  const outDir = join(root, 'build', 'desktop');
  mkdirSync(outDir, { recursive: true });
  const exeDst = join(outDir, 'gravitybox-desktop.exe');
  copyFileSync(exeSrc, exeDst);

  let loaderDst = null;
  if (existsSync(loaderSrc)) {
    loaderDst = join(outDir, 'WebView2Loader.dll');
    copyFileSync(loaderSrc, loaderDst);
  }

  warnIfLowIntegrityDir(outDir);

  process.stdout.write(`✅ Desktop build ready: ${exeDst}\n`);
  return { outDir, exePath: exeDst, loaderPath: loaderDst, profileDir };
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const debug = process.argv.includes('--debug');
  const skipBackend = process.argv.includes('--skip-backend');
  buildDesktop({ release: !debug, skipBackend });
}
