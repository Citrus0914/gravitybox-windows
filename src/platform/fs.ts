import type { Stats } from 'node:fs';

export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';

/**
 * Check whether a filesystem entry belongs to the current user.
 * Windows `fs.stat().uid` is always 0 and `process.getuid` is undefined.
 */
export function isOwnedByCurrentUser(info: Pick<Stats, 'uid'>): boolean {
  if (isWindows) return true;
  return info.uid === process.getuid?.();
}

/** Validate that a stat entry is a regular, non-symlink file owned by the current user. */
export function isRegularUserFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && isOwnedByCurrentUser(info);
}

/** Validate that a stat entry is a regular, non-symlink directory owned by the current user. */
export function isUserDirectory(info: Stats): boolean {
  return !info.isSymbolicLink() && info.isDirectory() && isOwnedByCurrentUser(info);
}
