// The page tells its window whether the person looks at it (issue 174, `looking`): visible and focused. While any client
// of the window looks, the server marks its session seen, so a reply read here is read on every client.
import { useEffect } from 'react';
import { has, type ClientMessage, type ServerEvent } from '@nota-bene/shared';
import { connection } from '@/sdk';

/**
 * While it looks, how often the page checks again: focus inside a frame of the page (the HTML view) that then leaves the
 * app blurs only the frame's window, so the page hears no event of its own.
 */
export const LOOK_CHECK_MS = 1000;

type Conn = { hello(): { protocol: number } | null; send(m: ClientMessage): boolean; onEvent(fn: (ev: ServerEvent) => void): () => void };

/** Says `looking` on each change, and again at each `hello` (a new socket knows nothing of it); only to a server of 41. */
export function startLooking(conn: Conn, doc: Document, win: Window): () => void {
  let told: boolean | null = null;
  let check: ReturnType<typeof setInterval> | undefined;
  const tell = (again: boolean) => {
    const on = !doc.hidden && doc.hasFocus();
    if ((on !== told || again) && has(conn.hello()?.protocol, 'looking') && conn.send({ type: 'looking', on })) told = on;
    if (told === true) check ??= setInterval(change, LOOK_CHECK_MS);
    else if (check !== undefined) { clearInterval(check); check = undefined; }
  };
  const change = () => tell(false);
  const off = conn.onEvent((ev) => { if (ev.kind === 'hello') tell(true); });
  win.addEventListener('focus', change);
  win.addEventListener('blur', change);
  doc.addEventListener('visibilitychange', change);
  change();
  return () => {
    off();
    clearInterval(check);
    win.removeEventListener('focus', change);
    win.removeEventListener('blur', change);
    doc.removeEventListener('visibilitychange', change);
  };
}

/** startLooking as a part of the frame (a slot), rendering nothing. */
export function Looking(): null {
  useEffect(() => startLooking(connection, document, window), []);
  return null;
}
