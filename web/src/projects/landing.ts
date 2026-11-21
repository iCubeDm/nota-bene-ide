// The other end of a hand-off to a session (api.ts enterProject with a session): the URL said `&s=<id>` (or `new`), so
// once this window tells its session the page switches to that one (or a new one). Once; a refusal is a toast.
import { t, toast, selectConn, selectSession, type AppStore, switchSession, type SwitchResult } from '@/sdk';
import { REFUSED } from '@/controls/useNote.ts';

export function startLanding(store: AppStore, session: string, switchFn?: (id: string | null, dir: string) => SwitchResult): () => void {
  const sw = switchFn ?? ((id: string | null, dir: string) => store.dispatch(switchSession(id, dir)));
  let done = false;
  const check = () => {
    const st = store.getState();
    const cur = selectSession(st);
    if (done || selectConn(st) !== 'open' || !cur) return;
    done = true;
    unsubscribe();
    // a fresh window may have no id until its first turn: it already is a new session
    if (cur.id ? cur.id.toLowerCase() === session.toLowerCase() : session === 'new') return;
    const r = sw(session === 'new' ? null : session, cur.root);
    if (r !== 'sent') toast(t('projLandFailed'), t(REFUSED[r]));
  };
  const unsubscribe = store.subscribe(check);
  check();
  return unsubscribe;
}
