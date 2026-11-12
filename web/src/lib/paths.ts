import { basename, toSlash } from '@nota-bene/shared/paths';

// Paths as the UI shows and keys them. The server sends absolute paths in its wire form (`/Users/x/proj` on macOS and
// Linux, `C:/Users/x/proj` on Windows); an agent writes free text with either separator (`C:\Users\x\a.png`,
// `src\a.ts`). A POSIX path is never rewritten: there a backslash is a name character.

/** A Windows drive path, either separator: `C:\a`, `c:/a`. */
export const isDrivePath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p);

/** An absolute path in the wire form: a drive path in `toSlash` form (`c:\T\a.png` → `C:/T/a.png`), anything else as is. */
export const wireAbs = (p: string): string => (isDrivePath(p) ? toSlash(p) : p);

/** Whether `abs` is `dir` or under it, both in the wire form and `dir` without a trailing `/`; letter case is ignored for
 *  a drive path (NTFS names). `abs.slice(dir.length)` is then what follows: `''` or `/rest`. */
export function underDir(abs: string, dir: string): boolean {
  const head = abs.slice(0, dir.length);
  if (!(isDrivePath(dir) ? head.toLowerCase() === dir.toLowerCase() : head === dir)) return false;
  return abs.length === dir.length || abs[dir.length] === '/';
}

/** A project-relative path an agent wrote with Windows separators (`src\a.ts`, `..\b.md`) in the `/` form the tabs and
 *  comment keys use; a path with a `/` already, or anything that is not a plain run of names (`\n`, `a\*b`), as is. */
export const slashRel = (p: string): string =>
  (/^[^\\/\s:*?"<>|`][^\\/:*?"<>|`\n]*(?:\\[^\\/:*?"<>|`\n]+)+\\?$/.test(p) ? p.replace(/\\/g, '/') : p);

/** The last folder name of an absolute path for a title or a label (`C:/Users/x/proj` → `proj`); `''` for a root. */
export const folderName = (p: string): string =>
  (isDrivePath(p) || p.startsWith('\\\\') ? basename(p) : p.split('/').filter(Boolean).pop()) ?? '';

/** `C:/Users/<name>` (either separator, any case) shortened to `~`; other paths as is (each view shortens its own POSIX homes). */
export const shortWinHome = (p: string): string => (isDrivePath(p) ? toSlash(p).replace(/^[A-Z]:\/Users\/[^/]+/i, '~') : p);
