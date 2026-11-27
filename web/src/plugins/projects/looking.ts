// The page tells its window whether the person looks at it (issue 174, `looking`): visible and focused. While any client
// of the window looks, the server marks its session seen, so a reply read here is read on every client.
import { useEffect } from 'react';
import { has, type ClientMessage, type ServerEvent } from '@nota-bene/shared';
import { connection } from '@/sdk';

type Conn = { hello(): { protocol: number } | null; send(m: ClientMessage): boolean; onEvent(fn: (ev: ServerEvent) => void): () => void };

/** Says `looking` on each change, and again at each `hello` (a new socket knows nothing of it); only to a server of 41. */
export function startLooking(conn: Conn, doc: Document, win: Window): () => void {
  let told: boolean | null = null;
  const tell = (again: boolean) => {
    const on = !doc.hidden && doc.hasFocus();
    if ((on === told && !again) || !has(conn.hello()?.protocol, 'looking')) return;
    if (conn.send({ type: 'looking', on })) told = on;
  };
  const change = () => tell(false);
  const off = conn.onEvent((ev) => { if (ev.kind === 'hello') tell(true); });
  win.addEventListener('focus', change);
  win.addEventListener('blur', change);
  doc.addEventListener('visibilitychange', change);
  change();
  return () => {
    off();
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
