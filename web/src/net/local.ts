import { apiFetch } from './auth.ts';

/** Another computer's window shown through this one's connector (issue 297): that computer's host id and name. */
export type RemotePage = { host: string; name: string };

/** What `GET /system/remote/page` said at start; a seam for the tests. */
export const page: { remote: RemotePage | null } = { remote: null };

/**
 * Asks once at start, before the app renders, whether this page is another computer's window (the desktop proxy answers
 * `{host, name}`, server/src/remote/proxy.ts; a window of its own answers null, an older one something else).
 */
export async function loadRemotePage(fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    const r = await apiFetch('/system/remote/page', { cache: 'no-store' }, fetchFn);
    const j = r.ok ? ((await r.json()) as Partial<RemotePage> | null) : null;
    page.remote = j && typeof j.host === 'string' && typeof j.name === 'string' ? { host: j.host, name: j.name } : null;
  } catch {
    page.remote = null;
  }
}

/** This page is another computer's window, shown through this one's (no folders, starts or stops of this computer here). */
export const remotePage = (): RemotePage | null => page.remote;

/**
 * Whether this page is on the computer the window runs on (issue 461): the server listens on loopback only, so a page
 * reached any other way (a relay, a tunnel) is on another machine, and so is one a desktop proxy shows on `localhost`
 * (issue 297). Show in Finder and Open are offered only here; the server refuses them for anything but this machine's
 * page anyway (server/src/osFiles.ts).
 */
export const isLocalPage = (host: string = location.hostname): boolean => !page.remote && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]');
