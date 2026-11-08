import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { restartAgent, restartServer, selectSwitching, stopWindow } from '@/controls/slice.ts';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { selectBusy, selectConn, useAppDispatch, useAppSelector } from '@/store/store.ts';
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

/**
 * ↻ restarts the agent (R-M4-1); the chevron opens the menu, whose second item restarts the whole server (R-M5-1) and whose
 * last stops the window, after a confirmation that warns of a running turn.
 */
export function RestartMenu() {
  const t = useT();
  const d = useAppDispatch();
  const switching = useAppSelector(selectSwitching);
  const { supervised, codeChanged } = useServerInfo();
  const busy = useAppSelector(selectBusy);
  const [askStop, setAskStop] = useState(false);
  const btn = 'cursor-pointer whitespace-nowrap border border-border-soft px-2 py-0.5 text-[0.6875rem] font-medium hover:text-foreground disabled:cursor-default disabled:opacity-50';
  return (
    <span className="flex items-center gap-1.5">
      {supervised && codeChanged && (
        <button type="button" id="codeUpdatedBtn" title={t('codeUpdatedTip')} disabled={switching} onClick={() => void d(restartServer())} className={`${btn} rounded-md border-warn text-warn`}>
          {t('codeUpdated')}
        </button>
      )}
      <span className="flex items-center">
        {/* enabled while busy: the escape hatch for a stuck agent (R-M4-4); only a running switch/restart disables it */}
        <button type="button" id="restartBtn" aria-label={t('restartAgent')} title={t('restartTip')} disabled={switching} onClick={() => d(restartAgent())} className={`${btn} relative rounded-l-md [&>svg]:text-accent-agent`}>
          <Svg size={14}>{ICONS.restart}</Svg>
          {/* the A of Agent on the arrow's corner: this ↻ restarts the agent, the server is in the menu */}
          <span data-agent-mark aria-hidden className="pointer-events-none absolute right-[3px] bottom-[1px] font-sans text-[0.5rem] font-bold leading-none text-accent-agent">A</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" id="restartMenuBtn" aria-label={t('restartMenu')} disabled={switching} className={`${btn} -ml-px rounded-r-md px-1`}>
              ▾
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => d(restartAgent())}>{t('restartAgent')}</DropdownMenuItem>
            {supervised && (
              <DropdownMenuItem title={t('restartServerTip')} onSelect={() => void d(restartServer())}>{t('restartServer')}</DropdownMenuItem>
            )}
            <DropdownMenuItem title={t('stopWindowTip')} onSelect={() => setAskStop(true)}>{t('stopWindow')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {askStop && (
        <ConfirmDialog title={t('stopWindowTitle')} body={busy ? `${t('stopWindowQ')}\n${t('stopWindowBusy')}` : t('stopWindowQ')} confirm={t('winStop')}
          onCancel={() => setAskStop(false)} onConfirm={() => { setAskStop(false); void d(stopWindow()); }} />
      )}
    </span>
  );
}
