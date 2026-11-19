import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WinTcpOwner {
  pid: number;
  exe: string;
  names: string[];
}

export interface WinLsPorts {
  pid: number;
  exe: string;
  listeners: string[];
}

export interface WinProcessEntry {
  pid: number;
  exe: string;
  cmd: string;
}

export interface WinExeInfo {
  fileVersion: string;
  productName: string;
  companyName: string;
  signed: boolean;
  trustStatus: number;
}

function resolveWinHelperPath(): string {
  const override = process.env.GRAVITYBOX_WIN_HELPER_PATH;
  if (override && existsSync(override)) return resolve(override);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, 'gb-win-helper.exe'),
    join(moduleDir, '..', 'gb-win-helper.exe'),
    join(moduleDir, '..', '..', 'dist', 'gb-win-helper.exe'),
    join(moduleDir, '..', '..', 'native-win', 'gb-win-helper', 'target', 'release', 'gb-win-helper.exe'),
    join(moduleDir, '..', '..', 'native-win', 'gb-win-helper', 'target', 'debug', 'gb-win-helper.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('gb-win-helper.exe not found');
}

async function runHelper(args: string[], timeout = 5000): Promise<{ stdout: string; stderr: string }> {
  const helper = resolveWinHelperPath();
  return execFileAsync(helper, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

export async function winCredRead(service: string, account: string): Promise<string | null> {
  const helper = resolveWinHelperPath();
  try {
    const { stdout } = await execFileAsync(helper, ['cred', 'read', service, account], {
      timeout: 5000,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch (error) {
    if ((error as { code?: number }).code === 44) return null;
    throw error;
  }
}

export async function winCredWrite(service: string, account: string, password: string): Promise<void> {
  const helper = resolveWinHelperPath();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(helper, ['cred', 'write', service, account], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolvePromise();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('winCredWrite timeout'));
    }, 5000);
    child.stdin.on('error', () => {});
    child.stdin.end(password, 'utf8');
    child.on('close', code => {
      if (code === 0) finish();
      else finish(new Error(`winCredWrite exited with ${code}`));
    });
    child.on('error', err => finish(err));
  });
}

export async function winCredDelete(service: string, account: string): Promise<void> {
  const helper = resolveWinHelperPath();
  try {
    await execFileAsync(helper, ['cred', 'delete', service, account], {
      timeout: 5000,
      windowsHide: true,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 44) return;
    throw error;
  }
}

export async function winTcpOwners(port: number): Promise<WinTcpOwner[]> {
  const { stdout } = await runHelper(['tcp-owners', String(port)], 4000);
  return JSON.parse(stdout || '[]') as WinTcpOwner[];
}

export async function winLsPorts(pid: number): Promise<WinLsPorts> {
  const { stdout } = await runHelper(['ls-ports', String(pid)], 4000);
  return JSON.parse(stdout || '{"pid":0,"exe":"","listeners":[]}') as WinLsPorts;
}

export async function winPsList(): Promise<WinProcessEntry[]> {
  try {
    const { stdout } = await runHelper(['ps-list'], 5000);
    const parsed = JSON.parse(stdout || '[]') as WinProcessEntry[];
    if (parsed.length >= 10 && parsed.some(entry => entry.pid === process.pid)) {
      return parsed;
    }
  } catch {}
  const psScript =
    'Get-CimInstance Win32_Process | Select-Object @{N="pid";E={[int]$_.ProcessId}},@{N="exe";E={[string]$_.ExecutablePath}},@{N="cmd";E={[string]$_.CommandLine}} | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const raw = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(raw) ? (raw as WinProcessEntry[]) : raw ? [raw as WinProcessEntry] : [];
}

export async function winExeInfo(exePath: string): Promise<WinExeInfo> {
  const { stdout } = await runHelper(['exe-info', exePath], 6000);
  return JSON.parse(stdout) as WinExeInfo;
}

export async function winTrashMove(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await runHelper(['trash', ...paths], 15000);
    return;
  } catch {
    // Fallback via PowerShell (runs at Medium integrity if workspace helper binary is blocked from loading shell32.dll)
    const script = [
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      'foreach ($p in $args) {',
      '  if (Test-Path -LiteralPath $p -PathType Container) {',
      '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin")',
      '  } elseif (Test-Path -LiteralPath $p) {',
      '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin")',
      '  }',
      '}',
    ].join('\n');
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, ...paths], {
      timeout: 20000,
      windowsHide: true,
    });
  }
}
