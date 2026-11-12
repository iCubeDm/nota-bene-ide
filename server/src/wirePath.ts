import { toSlash } from '@nota-bene/shared/paths';
import { isWindows } from './platform.ts';

/**
 * An absolute path in the one form the wire carries (hello's tmpDirs, the session event, /sessions, /sources, the
 * windows list): on Windows `toSlash`'s (`C:\Users\x\proj` → `C:/Users/x/proj`; give it a native realpath for the
 * on-disk case and long names), which the server's fs calls accept back as is. POSIX: unchanged. Kept out of
 * platform.ts, which the launcher imports without the workspace packages.
 */
export const wirePath = (p: string, platform: NodeJS.Platform = process.platform): string => (isWindows(platform) ? toSlash(p) : p);
