import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDesktop } from './build-desktop.mjs';
import { scanDirectoryForPrivacy } from './check-privacy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export async function packageWindows({ skipTests = false } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('tools/package-win.mjs must be run on Windows');
  }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = pkg.version || '1.1.1';

  const built = buildDesktop({ release: true });

  if (!skipTests) {
    execFileSync('node', [join(root, 'tools', 'run-tests.mjs'), '--fast'], {
      cwd: root,
      stdio: 'inherit',
    });
  }

  const stageName = `GravityBox-${version}-win-x64`;
  const stageDir = join(root, 'build', stageName);
  const coreDir = join(stageDir, 'core');
  const runtimeDir = join(stageDir, 'runtime');

  mkdirSync(stageDir, { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  // 1. Desktop shell & WebView2 loader
  copyFileSync(built.exePath, join(stageDir, 'GravityBox.exe'));
  if (built.loaderPath && existsSync(built.loaderPath)) {
    copyFileSync(built.loaderPath, join(stageDir, 'WebView2Loader.dll'));
  }

  // 2. Node.js runtime
  copyFileSync(process.execPath, join(runtimeDir, 'node.exe'));

  // 3. Core Node backend, dicts, and runtime assets
  const coreDist = join(coreDir, 'dist');
  mkdirSync(coreDist, { recursive: true });
  cpSync(join(root, 'dist'), coreDist, { recursive: true, force: true });

  cpSync(join(root, 'dict'), join(coreDir, 'dict'), { recursive: true, force: true });

  const assetsDst = join(coreDir, 'assets');
  mkdirSync(assetsDst, { recursive: true });
  for (const item of [
    'i18n',
    'icons',
    'model-icons',
    'master-1024.png',
    'model-catalog.json',
    'pricing-feed.json',
    'ui-extraction-manifest.json',
  ]) {
    const src = join(root, 'assets', item);
    if (existsSync(src)) {
      cpSync(src, join(assetsDst, item), { recursive: true, force: true });
    }
  }

  copyFileSync(join(root, 'package.json'), join(coreDir, 'package.json'));
  for (const doc of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const src = join(root, doc);
    if (existsSync(src)) copyFileSync(src, join(stageDir, doc));
  }

  // 4. Privacy gate on staged core bundle
  const privacy = await scanDirectoryForPrivacy(coreDir);
  if (privacy.issues.length > 0) {
    throw new Error(
      `Privacy check failed on staged package (${privacy.issues.length} issues): ${privacy.issues[0].file}:${privacy.issues[0].line}`,
    );
  }

  // 5. Create portable ZIP & SHA-256 checksum
  const zipPath = join(root, 'build', `${stageName}.zip`);
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${stageDir.replaceAll("'", "''")}\\*' -DestinationPath '${zipPath.replaceAll("'", "''")}' -Force`,
    ],
    { cwd: root, stdio: 'inherit' },
  );

  const checksum = sha256File(zipPath);
  const shaPath = `${zipPath}.sha256`;
  writeFileSync(shaPath, `${checksum}  ${stageName}.zip\n`, 'utf8');

  process.stdout.write(`✅ Windows portable package created:\n   ${stageDir}\n   ${zipPath}\n   sha256: ${checksum}\n`);
  return { stageDir, zipPath, shaPath, checksum };
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skipTests = process.argv.includes('--skip-tests');
  packageWindows({ skipTests }).catch((err) => {
    process.stderr.write(`❌ package:win failed: ${err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
}
