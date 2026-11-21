import { MODES } from '@nota-bene/shared';
import { routes, selectCapabilitiesKnown, systemPrefs, useAppSelector, useResource, useSettings, useT, type SettingsSection } from '@/sdk';
import { SettingsFail, SettingsRow } from '@/sdk/ui';

/** Settings → Defaults: the mode a new session starts in, of the modes the agent has. */
function ModeRow({ active }: { active: boolean }) {
  const t = useT();
  const { post } = useSettings();
  const capabilities = useAppSelector(selectCapabilitiesKnown);
  const prefs = useResource(systemPrefs, undefined, { on: active });
  return (
    <SettingsRow label={t('defMode')}>
      <SettingsFail error={prefs.failed ? prefs.error : null} />
      {prefs.data && (
        <select aria-label={t('defMode')} value={prefs.data.defaultMode}
          onChange={(e) => void post(routes.systemPrefs(), { defaultMode: e.target.value }).then(prefs.refresh)}
          className="rounded-md border border-border-soft bg-transparent px-2 py-1 text-[0.8125rem] text-foreground">
          {(capabilities?.modes ?? MODES).map((m) => <option key={m} value={m}>{t(`mode_${m}`)}</option>)}
        </select>
      )}
    </SettingsRow>
  );
}

export const controlsSettings: SettingsSection[] = [{ id: 'mode', in: 'defaults', order: 30, render: ModeRow }];
