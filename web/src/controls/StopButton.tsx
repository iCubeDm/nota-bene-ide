import { useState } from 'react';
import { useT, selectBusy, useAppDispatch, useAppSelector, routes, toast, selectSwitching, stopWindow, remotePage, connections, send } from '@/sdk';
import { ConfirmDialog, ICONS, Svg } from '@/sdk/ui';

/** The header's Stop Nota Bene, before this window stops itself: every other window; how many could not be stopped. */
async function stopOthers(): Promise<number> {
  try {
    const r = await send(routes.systemProjects('stop-others'), {});
    if (!r.ok) return -1;
    const j = (await r.json()) as { failed?: unknown };
    return typeof j.failed === 'number' ? j.failed : -1;
  } catch {
    return -1;
  }
}

/**
 * ⏻ in the header's corner: Stop Nota Bene. After a confirmation that warns of a running turn (here or in another window),
 * every other window stops first (/system/projects/stop-others), then this one, its agent and its launcher; the sessions
 * stay and the tab parks on the Stopped overlay. If another window does not stop, this one stays open: it is the way back
 * to the rest (a single project is stopped from the project list). Not on another computer's page shown through this one
 * (issue 297): its projects are not stopped from here.
 */
export function StopButton() {
  const t = useT();
  const d = useAppDispatch();
  const busy = useAppSelector(selectBusy);
  const switching = useAppSelector(selectSwitching);
  const [ask, setAsk] = useState(false);
  const [othersBusy, setOthersBusy] = useState(false);
  const open = () => {
    setAsk(true);
    setOthersBusy(false);
    connections.current().fetch(routes.systemProjects()).then((r) => (r.ok ? r.json() : null)).then((j: { running?: { state?: string; current?: boolean; remote?: object }[] } | null) => {
      setOthersBusy(!!j?.running?.some((w) => !w.current && !w.remote && w.state === 'working'));
    }).catch(() => {});
  };
  const stop = async () => {
    setAsk(false);
    if ((await stopOthers()) !== 0) return toast(t('stopAllFail'), '');
    void d(stopWindow());
  };
  if (remotePage()) return null;
  return (
    <>
      <button
        type="button"
        id="stopWindowBtn"
        aria-label={t('stopWindow')}
        title={t('stopWindow')}
        disabled={switching}
        onClick={open}
        className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive disabled:cursor-default disabled:opacity-50"
      >
        <Svg size={15}>{ICONS.power}</Svg>
      </button>
      {ask && (
        <ConfirmDialog title={t('stopWindowTitle')} body={busy || othersBusy ? `${t('stopWindowQ')}\n${t('stopWindowBusy')}` : t('stopWindowQ')} confirm={t('winStop')}
          onCancel={() => setAsk(false)} onConfirm={() => void stop()} />
      )}
    </>
  );
}
