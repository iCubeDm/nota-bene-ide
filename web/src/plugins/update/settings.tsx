import { defineResource, routes, systemPrefs, useResource, useSettings, useT, type SettingsSection } from '@/sdk';
import { SettingsRow } from '@/sdk/ui';
import { recheckUpdate } from './UpdateNotice.tsx';

/** the update's status as Settings reads it: once per showing, not on the notice's poll */
export const autoResource = defineResource<void, { auto: boolean }>({ id: 'update.auto', key: () => '', route: () => routes.systemUpdate() });

/** Settings → Defaults: whether the server looks for a new release (off for good under NOTA_BENE_NO_UPDATE_CHECK). */
function CheckRow({ active }: { active: boolean }) {
  const t = useT();
  const { post } = useSettings();
  const prefs = useResource(systemPrefs, undefined, { on: active });
  const p = prefs.data;
  return (
    <SettingsRow label={t('defUpdate')}>
      {p && (
        <span className="flex flex-col gap-1">
          <input type="checkbox" aria-label={t('defUpdate')} checked={p.updateCheck === true} disabled={p.updateCheckForcedOff}
            onChange={(e) => void post(routes.systemPrefs(), { updateCheck: e.target.checked }).then(prefs.refresh).then(recheckUpdate)}
            className="size-3.5 accent-primary" />
          {p.updateCheckForcedOff && <span className="text-xs text-muted-foreground">{t('defUpdateEnv')}</span>}
        </span>
      )}
    </SettingsRow>
  );
}

/** Settings → Defaults: install a found release by itself, at the next pause. */
function AutoRow({ active }: { active: boolean }) {
  const t = useT();
  const { post } = useSettings();
  const prefs = useResource(systemPrefs, undefined, { on: active });
  const upd = useResource(autoResource, undefined, { on: active });
  return (
    <SettingsRow label={t('settingsAutoUpdate')}>
      {prefs.data && (
        <span className="flex flex-col gap-1">
          <input type="checkbox" aria-label={t('settingsAutoUpdate')} checked={upd.data?.auto === true} disabled={prefs.data.updateCheck !== true || !upd.data}
            onChange={(e) => void post(routes.systemUpdate('auto'), { on: e.target.checked }).then(upd.refresh).then(recheckUpdate)}
            className="size-3.5 accent-primary" />
          <span className="text-xs text-muted-foreground">{t('settingsAutoUpdateHint')}</span>
        </span>
      )}
    </SettingsRow>
  );
}

export const updateSettings: SettingsSection[] = [
  { id: 'updateCheck', in: 'defaults', order: 40, render: CheckRow },
  { id: 'updateAuto', in: 'defaults', order: 50, render: AutoRow },
];
