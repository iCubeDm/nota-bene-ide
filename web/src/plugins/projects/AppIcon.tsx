// "Add Nota Bene to your apps" (epic 383, start by click), a notification: while this computer can have the app icon and has
// none. Add installs it (server/src/shortcut.ts, as `nota-bene shortcut`); Not now hides it for 30 days. Only a page on this
// computer offers it: a phone's or another computer's page would put the icon here, not where its user is.
import { useEffect } from 'react';
import { defineResource, dismissToast, isLocalPage, json, routes, send, storage, toast, useResource, useT } from '@/sdk';

const LATER_MS = 30 * 86_400_000;
/** when Not now stops hiding the offer */
const LATER = storage.local<number>('nb.appIconLater', json((v): v is number => typeof v === 'number'), 0);

type Status = { can: boolean; installed: boolean };
export const shortcutResource = defineResource<void, Status>({ id: 'projects.shortcut', key: () => '', route: () => routes.systemShortcut() });

export function AppIcon() {
  const t = useT();
  const got = useResource(shortcutResource, isLocalPage() && LATER.get() <= Date.now() ? undefined : null);
  const offer = !!got.data?.can && !got.data.installed;
  useEffect(() => {
    if (!offer) return;
    const failed = () => toast(t('appIconFailed'), t('appIconFailedHint'));
    const add = () => void send(routes.systemShortcut('install')).then((r) => { if (!r.ok) failed(); }, failed);
    const id = toast(t('appIconOffer'), t('appIconTip'), {
      actions: [{ label: t('appIconAdd'), run: add }, { label: t('appIconLater'), run: () => LATER.set(Date.now() + LATER_MS) }],
    });
    return () => dismissToast(id);
  }, [offer, t]);
  return null;
}
