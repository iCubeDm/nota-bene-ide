import type { t as tNow } from '@/i18n/index.ts';

/** The shells of `! cmd` on Windows, as the server's prefs.ts has them (Settings → Defaults); other systems run $SHELL. */
export type WinShell = 'git-bash' | 'pwsh' | 'powershell' | 'cmd';
export type ShellChoice = 'auto' | WinShell;
/** the setting's order; `auto` takes the first of the first three that is installed */
export const WIN_SHELLS: readonly WinShell[] = ['git-bash', 'pwsh', 'powershell', 'cmd'];
/** product names, the same in every language */
export const SHELL_NAMES: Record<WinShell, string> = { 'git-bash': 'Git Bash', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'cmd' };

/** A `shell-end.error` in the user's language: the server words its own refusals as codes (session/shell.ts), the rest as is. */
export function shellError(t: typeof tNow, error: string): string {
  if (error === 'shell-cmd-one-line') return t('shellCmdOneLine');
  const missing = /^shell-missing:(.+)$/.exec(error)?.[1] as WinShell | undefined;
  return missing ? t('shellMissing', SHELL_NAMES[missing] ?? missing) : error;
}
