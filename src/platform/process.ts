import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isWindows } from './fs.js';
import { winLsPorts, winPsList } from './win-helper.js';

const execFileAsync = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  pcpu: number;
  command: string;
  exe?: string;
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  if (isWindows) {
    const entries = await winPsList();
    return entries.map(entry => ({
      pid: entry.pid,
      pcpu: 0,
      command: entry.cmd || entry.exe,
      exe: entry.exe,
    }));
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-ax', '-ww', '-o', 'pid=,pcpu=,args='], { timeout: 3000 });
  const rows: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: parseInt(m[1]!, 10),
      pcpu: parseFloat(m[2] || '0') || 0,
      command: m[3] || '',
    });
  }
  return rows;
}

export async function listLoopbackListenerPortsForPid(pid: number): Promise<number[]> {
  if (isWindows) {
    const info = await winLsPorts(pid);
    const ports: number[] = [];
    for (const listener of info.listeners) {
      const m = listener.match(/^127\.0\.0\.1:(\d+)$/);
      if (m) ports.push(parseInt(m[1]!, 10));
    }
    return Array.from(new Set(ports));
  }
  const { stdout } = await execFileAsync(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
    { timeout: 3000 },
  );
  const portMatches = Array.from(stdout.matchAll(/n127\.0\.0\.1:(\d+)/g)).map(m => parseInt(m[1]!, 10));
  return Array.from(new Set(portMatches));
}

export function normalizePathForCompare(value: string): string {
  const cleaned = value.trim().replace(/^"+|"+$/g, '');
  return isWindows ? cleaned.replace(/\//g, '\\').toLowerCase() : cleaned;
}

export function commandMatchesAppRoot(command: string, appRoot: string, exePath?: string): boolean {
  const normRoot = normalizePathForCompare(appRoot);
  const trimmedCmd = normalizePathForCompare(command);
  const normExe = exePath ? normalizePathForCompare(exePath) : '';
  const sep = appRoot.endsWith('.app') || !isWindows ? '/' : '\\';
  if (normExe && (normExe === normRoot || normExe.startsWith(normRoot + sep))) {
    return true;
  }
  return trimmedCmd.startsWith(normRoot + sep) || trimmedCmd.includes(normRoot + sep);
}

export function languageServerBinaryPath(appPath: string): string {
  if (appPath.endsWith('.app') || !isWindows) {
    return join(appPath, 'Contents', 'Resources', 'bin', 'language_server');
  }
  return join(appPath, 'resources', 'bin', 'language_server.exe');
}

export function commandMatchesLanguageServer(command: string, appPath: string, exePath?: string): boolean {
  const expected = normalizePathForCompare(languageServerBinaryPath(appPath));
  const posixFallback = normalizePathForCompare(join(appPath, 'Contents', 'Resources', 'bin', 'language_server'));
  if (exePath) {
    const normExe = normalizePathForCompare(exePath);
    if (normExe === expected || normExe === posixFallback) return true;
  }
  const cmdNorm = normalizePathForCompare(command);
  return [expected, posixFallback].some(
    candidate => cmdNorm.startsWith(candidate + ' ') || cmdNorm === candidate || cmdNorm.startsWith(`"${candidate}"`),
  );
}
