// The header's "Add Nota Bene to your apps" (epic 383, start by click): while this computer can have the app icon and has
// none. Add installs it (server/src/shortcut.ts, as `nota-bene shortcut`); Not now hides it for 30 days. Only a page on this
// computer offers it: a phone's or another computer's page would put the icon here, not where its user is.
import { useState } from 'react';
import { defineResource, isLocalPage, json, routes, send, storage, toast, useResource, useT } from '@/sdk';

const LATER_MS = 30 * 86_400_000;
/** when Not now stops hiding the offer */
const LATER = storage.local<number>('nb.appIconLater', json((v): v is number => typeof v === 'number'), 0);

type Status = { can: boolean; installed: boolean };
export const shortcutResource = defineResource<void, Status>({ id: 'projects.shortcut', key: () => '', route: () => routes.systemShortcut() });

const quiet = 'rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground';
const primary = 'rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90 disabled:opacity-50';

export function AppIcon() {
  const t = useT();
  const [later, setLater] = useState(() => LATER.get() > Date.now());
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const got = useResource(shortcutResource, isLocalPage() && !later ? undefined : null);
  if (later || added || !got.data?.can || got.data.installed) return null;
  const add = () => {
    setBusy(true);
    void send(routes.systemShortcut('install'))
      .then((r) => (r.ok ? setAdded(true) : toast(t('appIconFailed'), t('appIconFailedHint'))), () => toast(t('appIconFailed'), t('appIconFailedHint')))
      .finally(() => setBusy(false));
  };
  const notNow = () => {
    LATER.set(Date.now() + LATER_MS);
    setLater(true);
  };
  return (
    <span className="flex items-center gap-1 text-xs" title={t('appIconTip')}>
      <span className="text-muted-foreground">{t('appIconOffer')}</span>
      <button type="button" disabled={busy} onClick={add} className={primary}>{t('appIconAdd')}</button>
      <button type="button" onClick={notNow} className={quiet}>{t('appIconLater')}</button>
    </span>
  );
}
