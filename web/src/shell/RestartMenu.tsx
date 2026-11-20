import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { cancelRestart, restartAgent, restartInPause, restartServer, selectRestartPending, selectSwitching } from '@/controls/slice.ts';
import { selectPagePause } from './pagePause.ts';
import { selectConn, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { routes } from '@/sdk/routes.ts';
import { defineResource, useResource } from '@/sdk/repository.ts';

export const INFO_POLL_MS = 20_000;
/** while a restart is pending and this page is in its pause, it asks again this often (the server may still see work) */
export const PAUSE_ASK_MS = 5_000;

/**
 * gh-422: a pending restart goes once this page is in its pause too (no send on its way, no upload, no waiting question;
 * a draft does not hold it, the page stays): the server checks its own side again.
 */
function useRestartInPause(pending: boolean): void {
  const d = useAppDispatch();
  const paused = useAppSelector((s) => selectPagePause(s, { draft: false }));
  const switching = useAppSelector(selectSwitching);
  useEffect(() => {
    if (!pending || !paused || switching) return;
    void d(restartInPause());
    const id = setInterval(() => void d(restartInPause()), PAUSE_ASK_MS);
    return () => clearInterval(id);
  }, [pending, paused, switching, d]);
}

const infoResource = defineResource<void, { supervised?: unknown; codeChanged?: unknown }>({ key: () => '', route: routes.info, every: INFO_POLL_MS });

/**
 * `/info.supervised` and `.codeChanged`: read on load and after every reconnect (a relaunch may change them), on window
 * focus, and every 20 s while the tab is visible (the agent edits server code while the user watches). false on failure.
 */
function useServerInfo(): { supervised: boolean; codeChanged: boolean } {
  const conn = useAppSelector(selectConn);
  const { data, failed, refresh } = useResource(infoResource, undefined, { on: conn === 'open' });
  useEffect(() => {
    if (conn !== 'open') return;
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [conn, refresh]);
  return { supervised: !failed && data?.supervised === true, codeChanged: !failed && data?.codeChanged === true };
}

/** ↻ restarts the agent (R-M4-1); the chevron opens the menu, whose second item restarts the whole server (R-M5-1). */
export function RestartMenu() {
  const t = useT();
  const d = useAppDispatch();
  const switching = useAppSelector(selectSwitching);
  const { supervised, codeChanged } = useServerInfo();
  const pending = useAppSelector(selectRestartPending);
  useRestartInPause(pending);
  const [askNow, setAskNow] = useState(false);
  const btn = 'cursor-pointer whitespace-nowrap border border-border-soft py-0.5 text-[0.6875rem] font-medium hover:text-foreground disabled:cursor-default disabled:opacity-50';
  return (
    <span className="flex items-center gap-1.5">
      {pending && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" id="restartPendingChip" title={t('restartPendingTip')} className={`${btn} rounded-md border-warn px-2 text-warn`}>
              {t('restartPending')}
            </button>
          </PopoverTrigger>
          <PopoverContent aria-label={t('restartPending')} collisionPadding={8} className="grid w-[320px] gap-2 p-3 text-xs">
            <b className="text-[0.8125rem] font-semibold text-foreground">{t('restartPending')}</b>
            <span className="text-muted-foreground">{t('restartPendingTip')}</span>
            <span className="flex justify-end gap-1 pt-1">
              <button type="button" onClick={() => void d(cancelRestart())} className="rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">{t('restartCancel')}</button>
              <button type="button" onClick={() => setAskNow(true)} className="rounded bg-primary px-2 py-1 text-primary-foreground hover:opacity-90">{t('restartServerNow')}</button>
            </span>
          </PopoverContent>
        </Popover>
      )}
      {askNow && (
        <ConfirmDialog title={t('restartNowTitle')} body={t('restartNowQ')} confirm={t('restartNowBtn')} danger
          onCancel={() => setAskNow(false)}
          onConfirm={() => { setAskNow(false); void d(restartServer({ now: true })); }} />
      )}
      {supervised && codeChanged && !pending && (
        <button type="button" id="codeUpdatedBtn" title={t('codeUpdatedTip')} disabled={switching} onClick={() => void d(restartServer())} className={`${btn} rounded-md border-warn px-2 text-warn`}>
          {t('codeUpdated')}
        </button>
      )}
      {/* the halves stretch to one height: a text glyph's line box is taller than the icon's, and the seam showed it */}
      <span className="flex items-stretch">
        {/* enabled while busy: the escape hatch for a stuck agent (R-M4-4); only a running switch/restart disables it */}
        <button type="button" id="restartBtn" aria-label={t('restartAgent')} title={t('restartTip')} disabled={switching} onClick={() => d(restartAgent())} className={`${btn} relative inline-flex items-center rounded-l-md px-2 [&>svg]:text-accent-agent`}>
          <Svg size={14}>{ICONS.restart}</Svg>
          {/* the A of Agent on the arrow's corner: this ↻ restarts the agent, the server is in the menu */}
          <span data-agent-mark aria-hidden className="pointer-events-none absolute right-[3px] bottom-[1px] font-sans text-[0.5rem] font-bold leading-none text-accent-agent">A</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" id="restartMenuBtn" aria-label={t('restartMenu')} disabled={switching} className={`${btn} -ml-px inline-flex items-center rounded-r-md px-1`}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => d(restartAgent())}>{t('restartAgent')}</DropdownMenuItem>
            {supervised && !pending && (
              <DropdownMenuItem onSelect={() => void d(restartServer())}>{t('restartServer')}</DropdownMenuItem>
            )}
            {pending && <DropdownMenuItem onSelect={() => setAskNow(true)}>{t('restartServerNow')}</DropdownMenuItem>}
            {pending && <DropdownMenuItem onSelect={() => void d(cancelRestart())}>{t('restartCancel')}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </span>
  );
}
