import { basename } from '@nota-bene/shared/paths';
import { projectFileUrl } from '../refs/kinds.ts';

/** The drag type of files dragged from the Files tree onto the composer (issue 461): a JSON list of project-relative paths. */
export const PATHS_MIME = 'application/x-nota-bene-paths';

/** The project paths a drag carries from the tree, or null when it carries none. */
export function draggedPaths(dt: DataTransfer | null): string[] | null {
  if (!dt || ![...dt.types].includes(PATHS_MIME)) return null;
  try {
    const v: unknown = JSON.parse(dt.getData(PATHS_MIME));
    return Array.isArray(v) && v.every((p) => typeof p === 'string') ? v : [];
  } catch {
    return [];
  }
}

/**
 * Chrome and Edge's drag out of the browser (`DownloadURL`): dropped on Finder or the desktop the file is downloaded there.
 * It points at `/file`, which the login cookie opens: no token or key ever goes in it. Other browsers ignore the type.
 * The format is `mime:name:url`, so a colon in the name would cut it: it becomes `_`.
 */
export function downloadUrl(path: string, src: string, origin = location.origin): string {
  return `application/octet-stream:${basename(path).replace(/:/g, '_')}:${origin}${projectFileUrl(path, src)}&download=1`;
}
