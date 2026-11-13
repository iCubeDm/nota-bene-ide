import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { restartAgent, restartServer, selectSwitching } from '@/controls/slice.ts';
import { selectConn, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { apiFetch } from '@/net/auth.ts';

export const INFO_POLL_MS = 20_000;

/**
 * `/info.supervised` and `.codeChanged`: read on load and after every reconnect (a relaunch may change them), on window
 * focus, and every 20 s while the tab is visible (the agent edits server code while the user watches). false on failure.
 */
function useServerInfo(): { supervised: boolean; codeChanged: boolean } {
  const conn = useAppSelector(selectConn);
  const [info, setInfo] = useState({ supervised: false, codeChanged: false });
  useEffect(() => {
    if (conn !== 'open') return;
    let live = true;
    const read = () => {
      apiFetch('/info').then((r) => r.json()).then((j: { supervised?: unknown; codeChanged?: unknown }) => {
        if (live) setInfo({ supervised: j.supervised === true, codeChanged: j.codeChanged === true });
      }).catch(() => { if (live) setInfo({ supervised: false, codeChanged: false }); });
    };
    read();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read(); }, INFO_POLL_MS);
    window.addEventListener('focus', read);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', read); };
  }, [conn]);
  return info;
}

/** ↻ restarts the agent (R-M4-1); the chevron opens the menu, whose second item restarts the whole server (R-M5-1). */
export function RestartMenu() {
  const t = useT();
  const d = useAppDispatch();
  const switching = useAppSelector(selectSwitching);
  const { supervised, codeChanged } = useServerInfo();
  const btn = 'cursor-pointer whitespace-nowrap border border-border-soft py-0.5 text-[0.6875rem] font-medium hover:text-foreground disabled:cursor-default disabled:opacity-50';
  return (
    <span className="flex items-center gap-1.5">
      {supervised && codeChanged && (
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
            {supervised && (
              <DropdownMenuItem title={t('restartServerTip')} onSelect={() => void d(restartServer())}>{t('restartServer')}</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </span>
  );
}
