import type { RemoteState } from '@nota-bene/shared';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.tsx';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { openRemote } from '@/tabs/slice.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { indicator, selectRemote, type Indicator } from './slice.ts';

const DOT: Record<Indicator, string> = { off: '', connecting: 'bg-warn', online: 'bg-success', trouble: 'bg-destructive' };
export const TONE: Record<Indicator, string> = { off: 'text-muted-foreground', connecting: 'text-warn', online: 'text-success', trouble: 'text-destructive' };
export const WORD = { off: 'remoteStateOff', connecting: 'remoteStateConnecting', online: 'remoteStateOnline', trouble: 'remoteStateTrouble' } as const satisfies Record<Indicator, string>;

/** Why access is not working, in the person's terms: the relay's two refusals an access key explains, else its own words. */
export function troubleWhy(s: RemoteState | null, t: ReturnType<typeof useT>): string {
  const code = s?.lastError?.code;
  if (code === 4402) return t('remoteNeedsKey');
  if (code === 4405) return t('remoteKeyLimit');
  return s?.lastError?.message ?? t('remoteNotStarted');
}

/** The settings menu's Remote access row: the connector's state at a glance; it opens the Remote tab. */
export function RemoteMenuItem({ className }: { className: string }) {
  const t = useT();
  const d = useAppDispatch();
  const { supported, state } = useAppSelector(selectRemote);
  if (!supported) return null;
  const ind = indicator(state);
  const phones = state?.devices.filter((x) => x.online).length ?? 0;
  const tip = ind === 'off' ? t('remoteTipOff')
    : ind === 'connecting' ? t('remoteTipConnecting')
      : ind === 'online' ? t('remoteTipOnline', phones)
        : t('remoteTipTrouble', troubleWhy(state, t));
  return (
    <DropdownMenuItem id="remoteMenu" data-state={ind} title={tip} onSelect={() => d(openRemote())} className={className}>
      <Svg size={15}>{ICONS.remote}</Svg>
      <span className="flex-1">{t('remoteMenu')}</span>
      <span className={`flex items-center gap-1.5 ${TONE[ind]}`}>
        {ind !== 'off' && <span className={`size-1.5 rounded-full ${DOT[ind]}`} />}
        {t(WORD[ind])}
        {ind === 'online' && phones > 0 && <span data-phones className="tabular-nums">· {phones}</span>}
      </span>
    </DropdownMenuItem>
  );
}

/** The access state as a dot on the settings button, while access is on and a relay is saved. */
export function RemoteDot() {
  const { supported, state } = useAppSelector(selectRemote);
  const ind = indicator(state);
  if (!supported || ind === 'off') return null;
  return <span id="settingsDot" data-state={ind} className={`pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full ${DOT[ind]}`} />;
}
