import { useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { selectSwitching, stopWindow } from '@/controls/slice.ts';
import { selectBusy, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';

/**
 * ⏻ in the header's corner: stops this window, its agent and its launcher after a confirmation that warns of a running
 * turn. The session stays; the tab then parks on the Stopped overlay.
 */
export function StopButton() {
  const t = useT();
  const d = useAppDispatch();
  const busy = useAppSelector(selectBusy);
  const switching = useAppSelector(selectSwitching);
  const [ask, setAsk] = useState(false);
  return (
    <>
      <button
        type="button"
        id="stopWindowBtn"
        aria-label={t('stopWindow')}
        title={`${t('stopWindow')}: ${t('stopWindowTip')}`}
        disabled={switching}
        onClick={() => setAsk(true)}
        className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive disabled:cursor-default disabled:opacity-50"
      >
        <Svg size={15}>{ICONS.power}</Svg>
      </button>
      {ask && (
        <ConfirmDialog title={t('stopWindowTitle')} body={busy ? `${t('stopWindowQ')}\n${t('stopWindowBusy')}` : t('stopWindowQ')} confirm={t('winStop')}
          onCancel={() => setAsk(false)} onConfirm={() => { setAsk(false); void d(stopWindow()); }} />
      )}
    </>
  );
}
