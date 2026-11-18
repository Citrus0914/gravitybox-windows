import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isWindows } from './fs.js';

export function isNamedPipeEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('//./pipe/');
}

function localAppDataDir(home: string): string {
  if (home === homedir() && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  return join(home, 'AppData', 'Local');
}

function roamingAppDataDir(home: string): string {
  if (home === homedir() && process.env.APPDATA) return process.env.APPDATA;
  return join(home, 'AppData', 'Roaming');
}

export function defaultApplicationsDir(home = homedir()): string {
  if (isWindows) {
    return join(localAppDataDir(home), 'Programs');
  }
  return '/Applications';
}

export function defaultAppBundleName(): string {
  return isWindows ? 'Antigravity' : 'Antigravity.app';
}

export function defaultAppPath(home = homedir(), applicationsDir = defaultApplicationsDir(home)): string {
  return join(applicationsDir, defaultAppBundleName());
}

export function defaultProfileDir(home = homedir()): string {
  if (isWindows) {
    return join(roamingAppDataDir(home), 'Antigravity');
  }
  return join(home, 'Library', 'Application Support', 'Antigravity');
}

export function defaultStateDir(home = homedir()): string {
  if (isWindows) {
    return join(localAppDataDir(home), 'GravityBox');
  }
  return join(home, 'Library', 'Application Support', 'GravityBox');
}

export function defaultCacheDir(home = homedir()): string {
  if (isWindows) {
    return join(localAppDataDir(home), 'GravityBox', 'Cache');
  }
  return join(home, 'Library', 'Caches', 'GravityBox');
}

export function defaultTrashDir(home = homedir()): string {
  if (isWindows) {
    return join(defaultCacheDir(home), 'maintenance-trash');
  }
  return join(home, '.Trash');
}

export function defaultAppSupportDir(home = homedir()): string {
  if (isWindows) {
    return roamingAppDataDir(home);
  }
  return join(home, 'Library', 'Application Support');
}

export function controlEndpointForStateDir(stateDir: string): string {
  if (isWindows) {
    const normalized = resolve(stateDir).toLowerCase();
    const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\gravitybox-${digest}`;
  }
  return join(stateDir, 'control.sock');
}

export interface BundleLayoutPaths {
  asarPath: string;
  unpackedPackageJsonPath: string;
  executablePath: string;
  languageServerPath: string;
  infoPlistPath: string;
  codeResourcesPath: string;
}

export function bundleLayoutPaths(appPath: string, executableName = 'Antigravity'): BundleLayoutPaths {
  if (isWindows && !appPath.endsWith('.app')) {
    return {
      asarPath: join(appPath, 'resources', 'app.asar'),
      unpackedPackageJsonPath: join(appPath, 'resources', 'app', 'package.json'),
      executablePath: join(appPath, `${executableName}.exe`),
      languageServerPath: join(appPath, 'resources', 'bin', 'language_server.exe'),
      infoPlistPath: '',
      codeResourcesPath: '',
    };
  }
  return {
    asarPath: join(appPath, 'Contents', 'Resources', 'app.asar'),
    unpackedPackageJsonPath: join(appPath, 'Contents', 'Resources', 'app', 'package.json'),
    executablePath: join(appPath, 'Contents', 'MacOS', executableName),
    languageServerPath: join(appPath, 'Contents', 'Resources', 'bin', 'language_server'),
    infoPlistPath: join(appPath, 'Contents', 'Info.plist'),
    codeResourcesPath: join(appPath, 'Contents', '_CodeSignature', 'CodeResources'),
  };
}
