import { basename, toSlash } from '@nota-bene/shared/paths';

// Paths as the UI shows and keys them. The server sends absolute paths in its wire form (`/Users/x/proj` on macOS and
// Linux, `C:/Users/x/proj` on Windows); an agent writes free text with either separator (`C:\Users\x\a.png`,
// `src\a.ts`). Agent text is read with the server's separator (`serverSep`): on a macOS or Linux server a backslash is a
// name character and `C:/a` a relative path, exactly as before Windows support.

// The separator of the server's OS (its `path.sep`). The browser cannot tell by itself: it is learned from an absolute
// path the server sends (hello's temp folders, the session root). Until then `/`.
let sep: '/' | '\\' = '/';

/** The server's directory separator: `\` for a Windows server, else `/`. */
export const serverSep = (): '/' | '\\' => sep;
export const setServerSep = (s: '/' | '\\'): void => {
  sep = s;
};

/** Learns `serverSep` from an absolute path in the server's wire form: `C:/...` or a UNC `//host/...` means Windows,
 *  any other `/...` POSIX; anything else (none, a relative path) changes nothing. */
export function learnServerSep(wire: unknown): void {
  if (typeof wire !== 'string') return;
  if (/^[A-Z]:\//i.test(wire) || wire.startsWith('//')) sep = '\\';
  else if (wire.startsWith('/')) sep = '/';
}

/** A Windows drive path, either separator: `C:\a`, `c:/a`. */
export const isDrivePath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p);

/** `isDrivePath` for a path an agent wrote: only on a Windows server (on a POSIX one `C:/a` is a relative path). */
export const isServerDrivePath = (p: string): boolean => sep === '\\' && isDrivePath(p);

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
 *  comment keys use; a path with a `/` already, or anything that is not a plain run of names (`\n`, `a\*b`), as is.
 *  Only on a Windows server: on a POSIX one `a\b.ts` is a file name. */
export const slashRel = (p: string): string =>
  (sep === '\\' && /^[^\\/\s:*?"<>|`][^\\/:*?"<>|`\n]*(?:\\[^\\/:*?"<>|`\n]+)+\\?$/.test(p) ? p.replace(/\\/g, '/') : p);

/** The last folder name of an absolute path for a title or a label (`C:/Users/x/proj` → `proj`); `''` for a root. */
export const folderName = (p: string): string =>
  (isDrivePath(p) || p.startsWith('\\\\') ? basename(p) : p.split('/').filter(Boolean).pop()) ?? '';

/** `C:/Users/<name>` (either separator, any case) shortened to `~`; other paths as is (each view shortens its own POSIX homes). */
export const shortWinHome = (p: string): string => (isDrivePath(p) ? toSlash(p).replace(/^[A-Z]:\/Users\/[^/]+/i, '~') : p);
