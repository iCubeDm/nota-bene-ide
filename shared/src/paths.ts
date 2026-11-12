// Path strings as the browser and the server both see them, with either separator: POSIX (`/a/b`), Windows drive
// (`C:\a`, `C:/a`), UNC (`\\host\share`) and verbatim (`\\?\C:\a`) paths. Pure string work, no Node imports: the web
// bundle uses it too. The wire form of an absolute path is `toSlash`'s: forward slashes, upper-case drive (`C:/Users/x`).

/** Whether `p` is absolute on some OS: `/x`, `X:\` or `X:/`, a UNC `\\host\share` or a `\\?\` path. `C:x` (relative to
 *  the drive's current folder) is not. */
export const isAbsPath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

/**
 * `p` with forward slashes: backslashes become `/`, a drive letter is upper-cased (`c:\a` → `C:/a`, `\\?\c:\a` →
 * `//?/C:/a`), repeated slashes collapse except the leading `//` of a UNC path, and a trailing slash goes except on a
 * root (`/`, `C:/`). `.` and `..` are kept: this is a spelling change, not a resolution.
 */
export function toSlash(p: string): string {
  let s = p.replace(/\\/g, '/');
  const unc = s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/');
  if (unc) s = `/${s}`;
  s = s.replace(/^((?:\/\/[?.]\/)?)([a-z]):/, (_m, pre: string, d: string) => `${pre}${d.toUpperCase()}:`);
  if (s.length > 1 && s.endsWith('/') && !/^(?:\/\/[?.]\/)?[A-Za-z]:\/$/.test(s) && !/^\/+$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** The last name in `p`, either separator, trailing separators ignored (`C:\a\b\` → `b`); `''` for a root. */
export function basename(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(s)) return '';
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

// the root of a slash-form path: `/`, `C:/`, `//host/share`, `//?/C:/`; '' for a relative one
const rootOf = (s: string): string =>
  /^\/\/[?.]\/[A-Za-z]:\//.exec(s)?.[0] ?? /^\/\/[^/]+(\/[^/]+)?/.exec(s)?.[0] ?? /^[A-Za-z]:\//.exec(s)?.[0] ?? (s.startsWith('/') ? '/' : '');

/** The folder of `p` in `toSlash` form: `C:\a\b` → `C:/a`, `/a` → `/`, a root stays itself, a bare name gives `.`. */
export function dirname(p: string): string {
  const s = toSlash(p);
  const root = rootOf(s);
  if (s.length <= root.length) return root || '.';
  const i = s.lastIndexOf('/');
  if (i < root.length) return root || '.';
  return s.slice(0, i) || root;
}

// `toSlash` with `.` and `..` resolved lexically (never above the root)
function resolved(p: string): string {
  const s = toSlash(p);
  const root = rootOf(s);
  const out: string[] = [];
  for (const seg of s.slice(root.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!root) out.push('..');
    } else out.push(seg);
  }
  const rest = out.join('/');
  return root ? (root.endsWith('/') || !rest ? root + rest : `${root}/${rest}`) : rest || '.';
}

/**
 * Whether `child` is `parent` or lies under it, either separator, `.`/`..` resolved lexically (symlinks are not: give
 * real paths). `caseInsensitive` for Windows paths (NTFS names), off by default. `/a/bc` is not inside `/a/b`.
 */
export function isInside(child: string, parent: string, { caseInsensitive = false }: { caseInsensitive?: boolean } = {}): boolean {
  let c = resolved(child);
  let p = resolved(parent);
  if (caseInsensitive) {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  if (c === p) return true;
  if (p === '.') return c !== '..' && !c.startsWith('../') && !isAbsPath(c);
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}
