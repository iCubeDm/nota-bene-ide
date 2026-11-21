import { routes, systemPrefs, useResource, useSettings, useT, type SettingsSection } from '@/sdk';
import { SettingsRow } from '@/sdk/ui';
import { SHELL_NAMES, WIN_SHELLS, type ShellChoice, type WinShell } from './shells.ts';

/**
 * Settings → Defaults, Windows only (the server sends `shells` there): which shell runs `! cmd`. A choice that is not
 * installed stays selectable and is marked: a run with it is refused, never handed to another shell.
 */
function ShellRow({ active }: { active: boolean }) {
  const t = useT();
  const { post } = useSettings();
  const prefs = useResource(systemPrefs, undefined, { on: active });
  const found = prefs.data?.shells as Record<WinShell, string | null> | undefined;
  if (!found) return null;
  const choice = (prefs.data?.shell ?? 'auto') as ShellChoice;
  const choose = (shell: ShellChoice) => void post(routes.systemPrefs(), { shell }).then(prefs.refresh);
  const auto = WIN_SHELLS.slice(0, 3).find((s) => found[s]);
  const name = (s: WinShell) => (found[s] ? SHELL_NAMES[s] : t('defShellMissing', SHELL_NAMES[s]));
  return (
    <SettingsRow label={t('defShell')}>
      <span className="flex flex-col gap-1">
        <select aria-label={t('defShell')} value={choice} onChange={(e) => choose(e.target.value as ShellChoice)}
          className="w-fit rounded-md border border-border-soft bg-transparent px-2 py-1 text-[0.8125rem] text-foreground">
          <option value="auto">{auto ? t('defShellAuto', SHELL_NAMES[auto]) : t('defShellAutoNone')}</option>
          {WIN_SHELLS.map((s) => <option key={s} value={s}>{name(s)}</option>)}
        </select>
        {choice !== 'auto' && !found[choice] ? <span role="alert" className="text-xs text-warn">{t('defShellMissingHint', SHELL_NAMES[choice])}</span>
          : <span className="text-xs text-muted-foreground">{choice === 'auto' ? t('defShellAutoHint') : found[choice]}</span>}
      </span>
    </SettingsRow>
  );
}

export const composerSettings: SettingsSection[] = [{ id: 'shell', in: 'defaults', order: 90, render: ShellRow }];
