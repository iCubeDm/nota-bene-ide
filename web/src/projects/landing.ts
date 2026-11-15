// The other end of a hand-off to a session (api.ts enterProject with a session): the URL said `&s=<id>` (or `new`), so
// once this window tells its session the page switches to that one (or a new one). Once; a refusal is a toast.
import { t } from '@/i18n/index.ts';
import { REFUSED } from '@/controls/useNote.ts';
import { switchSession, type SwitchResult } from '@/controls/slice.ts';
import { toast } from '@/shell/toast.ts';
import { selectConn, selectSession, type AppStore } from '@/store/store.ts';

export function startLanding(store: AppStore, session: string, switchFn?: (id: string | null, dir: string) => SwitchResult): () => void {
  const sw = switchFn ?? ((id: string | null, dir: string) => store.dispatch(switchSession(id, dir)));
  let done = false;
  const check = () => {
    const st = store.getState();
    const cur = selectSession(st);
    if (done || selectConn(st) !== 'open' || !cur?.id) return;
    done = true;
    unsubscribe();
    if (cur.id.toLowerCase() === session.toLowerCase()) return;
    const r = sw(session === 'new' ? null : session, cur.root);
    if (r !== 'sent') toast(t('projLandFailed'), t(REFUSED[r]));
  };
  const unsubscribe = store.subscribe(check);
  check();
  return unsubscribe;
}
