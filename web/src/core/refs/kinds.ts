import { AUDIO, IMAGE, VIDEO } from '@nota-bene/shared/cut';
import { serverSep } from '../lib/paths.ts';
import { connections } from '../sdk/connections.ts';
import { routes } from '../sdk/routes.ts';

export { AUDIO, IMAGE, VIDEO }; // shared: an edit's sources are these files
export const MD = /\.(md|markdown)$/i;
export const HTML = /\.html?$/i;

export type FileKind = 'md' | 'image' | 'video' | 'audio' | 'text';

export function kindOf(path: string): FileKind {
  if (MD.test(path)) return 'md';
  if (IMAGE.test(path)) return 'image';
  if (VIDEO.test(path)) return 'video';
  if (AUDIO.test(path)) return 'audio';
  return 'text';
}

/** Joins `p` onto `baseDir` ('/'-separated) and folds `.`/`..`. Returns null when it would climb above the root. */
function resolveIn(baseDir: string, p: string): string | null {
  const out: string[] = [];
  for (const seg of `${baseDir}/${p}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/**
 * URL of a project file. Relative paths resolve against `baseDir` (project-relative; none = project root).
 * A path that would climb above the root is sent as-is, so the server answers 403. `src`: another source (M3-16).
 */
export function fileUrl(p: string, baseDir?: string, src?: string): string {
  if (/^(https?:|data:|blob:)/.test(p)) return p;
  let path = p;
  try {
    path = decodeURI(p);
  } catch {
    // keep raw
  }
  if (baseDir && !path.startsWith('/')) path = resolveIn(baseDir, path) ?? `${baseDir}/${path}`;
  return projectFileUrl(path, src);
}

/** URL of a project-relative path taken as it is, not as a link: `a%20b.mp4` is that file's name (an edit's sources). */
export const projectFileUrl = (path: string, src?: string): string => connections.current().url(routes.file(path, { src }));

/** A project-relative path in agent text: never absolute (`/a`; on a Windows server also `C:\a`, `C:/a` or `\\host\share`),
 *  a URL or `~`. */
export const isPath = (p: string): boolean =>
  !(serverSep() === '\\' ? /^(https?:|~|\/|\\\\|[A-Za-z]:[\\/])/ : /^(https?:|~|\/)/).test(p) &&!/[\n`<>|*]/.test(p) && (/\//.test(p) || /\.[a-z0-9]{1,5}$/i.test(p));

/** The media's ETag (its version for media comments); undefined without one (a branch source) or on any failure. */
export const headVersion = (url: string, signal: AbortSignal): Promise<string | undefined> => (url.startsWith('/tmpimage') ? connections.current().fetch(url, { method: 'HEAD', signal }) : fetch(url, { method: 'HEAD', signal })).then(
  (r) => (r.ok ? r.headers.get('etag') ?? undefined : undefined),
  () => undefined, // no version: the mark simply cannot tell "the file changed"
);
