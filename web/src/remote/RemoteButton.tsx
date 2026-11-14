import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { openRemote } from '@/tabs/slice.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { indicator, selectRemote, type Indicator } from './slice.ts';

const DOT: Record<Indicator, string> = { off: '', connecting: 'bg-warn', online: 'bg-success', trouble: 'bg-destructive' };

/** The header's remote-access indicator: the connector's state at a glance; a click opens the Remote tab. */
export function RemoteButton() {
  const t = useT();
  const d = useAppDispatch();
  const { supported, state } = useAppSelector(selectRemote);
  if (!supported) return null;
  const ind = indicator(state);
  const phones = state?.devices.filter((x) => x.online).length ?? 0;
  const tip = ind === 'off' ? t('remoteTipOff')
    : ind === 'connecting' ? t('remoteTipConnecting')
      : ind === 'online' ? t('remoteTipOnline', phones)
        : t('remoteTipTrouble', state?.lastError?.message ?? t('remoteNotStarted'));
  return (
    <button
      type="button"
      id="remoteBtn"
      data-state={ind}
      aria-label={t('remote')}
      title={tip}
      onClick={() => d(openRemote())}
      className="relative grid h-7 min-w-7 place-items-center rounded-md px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <span className="flex items-center gap-0.5">
        <Svg size={15}>{ICONS.remote}</Svg>
        {ind === 'online' && phones > 0 && <span data-phones className="text-[0.6875rem] tabular-nums">{phones}</span>}
      </span>
      {ind !== 'off' && <span data-dot className={`absolute right-0.5 top-0.5 size-1.5 rounded-full ${DOT[ind]}`} />}
    </button>
  );
}
