import type { RemoteState } from '@nota-bene/shared';
import { useT, useAppDispatch, useAppSelector, openRemote, remotePage } from '@/sdk';
import { DropdownMenuItem, MENU_ROW, ICONS, Svg } from '@/sdk/ui';
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

/**
 * The settings menu's Remote access row: the connector's state at a glance; it opens the Remote tab. Not on another
 * computer's page shown through this one (issue 297): its proxy refuses /remote, the access is that computer's to change.
 */
export function RemoteMenuRow() {
  const t = useT();
  const d = useAppDispatch();
  const { supported, state } = useAppSelector(selectRemote);
  if (!supported || remotePage()) return null;
  const ind = indicator(state);
  const phones = state?.devices.filter((x) => x.online).length ?? 0;
  return (
    <DropdownMenuItem id="remoteMenu" data-state={ind} onSelect={() => d(openRemote())} className={MENU_ROW}>
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
  if (!supported || ind === 'off' || remotePage()) return null;
  return <span id="settingsDot" data-state={ind} className={`pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full ${DOT[ind]}`} />;
}
