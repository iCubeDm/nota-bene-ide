import { useT, type SettingsSection } from '@/sdk';
import { SettingsRow } from '@/sdk/ui';
import { railPref, useRailPref } from './railPref.ts';

/** Settings → Defaults: the open projects in a rail on the left. */
function RailRow() {
  const t = useT();
  const rail = useRailPref();
  return (
    <SettingsRow label={t('defRail')}>
      <span className="flex flex-col gap-1">
        <input type="checkbox" aria-label={t('defRail')} checked={rail !== false} onChange={(e) => railPref.choose(e.target.checked)}
          className="size-3.5 accent-primary" />
        <span className="text-xs text-muted-foreground">{t('defRailHint')}</span>
      </span>
    </SettingsRow>
  );
}

export const projectsSettings: SettingsSection[] = [{ id: 'rail', in: 'defaults', order: 70, render: RailRow }];
