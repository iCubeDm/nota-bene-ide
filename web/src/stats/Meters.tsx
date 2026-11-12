import type { Limit } from '@nota-bene/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { fmtK } from '@/lib/format.ts';
import { getLang, useT } from '@/i18n/index.ts';
import { selectCapabilitiesKnown } from '@/controls/slice.ts';
import { useAppSelector } from '@/store/store.ts';
import { selectStats } from './slice.ts';

export type Level = '' | 'warn' | 'hot';
export const meterLevel = (pct: number): Level => (pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : '');

const FILL: Record<Level, string> = { '': 'bg-primary', warn: 'bg-nb-accent', hot: 'bg-destructive' };

function Meter({ label, pct, tip }: { label: string; pct: number; tip: string }) {
  const level = meterLevel(pct);
  const shown = Math.round(pct);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="meter"
          tabIndex={0}
          aria-label={`${label} ${shown}%`}
          aria-valuenow={shown}
          aria-valuemin={0}
          aria-valuemax={100}
          data-level={level || undefined}
          className={`meter ${level} inline-flex cursor-default items-center gap-1.5 ${level === 'hot' ? 'text-destructive' : ''}`}
        >
          {label}
          <span className="block h-1 w-11 overflow-hidden rounded-sm outline outline-1 outline-meter-line bg-meter-track">
            <i className={`block h-full ${FILL[level]}`} style={{ width: `${Math.min(100, pct)}%` }} />
          </span>
          {shown}%
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function Meters() {
  const t = useT(); // re-renders on a language switch, so the reset time below is re-formatted too
  const st = useAppSelector(selectStats);
  const usage = useAppSelector(selectCapabilitiesKnown)?.usage;
  if (!st || !usage) return null;
  const resets = (l: Limit): string =>
    l.resets_at ? ` · ${t('resets', new Date(l.resets_at).toLocaleString(getLang(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}` : '';
  const L = st.limits;
  const windows = st.windows ?? [];
  const fiveHour = L?.five_hour ?? windows.find((w) => w.minutes === 300);
  const week = L?.seven_day ?? windows.find((w) => w.minutes === 10080);
  const parts = [
    st.context && <Meter key="ctx" label={t('ctx')} pct={st.context.pct} tip={t('ctxTip', fmtK(st.context.used), fmtK(st.context.max))} />,
    fiveHour && <Meter key="h5" label={t('h5')} pct={fiveHour.utilization} tip={`${t('h5Tip')}${resets(fiveHour)}`} />,
    week && <Meter key="week" label={t('week')} pct={week.utilization} tip={`${t('weekTip')}${resets(week)}`} />,
    ...windows.filter((w) => w.minutes !== 300 && w.minutes !== 10080).map((w, i) => <Meter key={`native-${i}`} label={w.minutes == null ? w.label : `${w.minutes % 60 === 0 ? w.minutes / 60 + 'h' : w.minutes + 'm'}`} pct={w.utilization} tip={`${w.label}${resets(w)}`} />),
    // on a plan the cost is not billed, but shows what the session's work is worth at API prices
    st.cost != null && (
      <Tooltip key="cost">
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={t(L ? 'costPlanTip' : 'costTip')} className="cursor-default">${st.cost.toFixed(2)}</span>
        </TooltipTrigger>
        <TooltipContent>{t(L ? 'costPlanTip' : 'costTip')}</TooltipContent>
      </Tooltip>
    ),
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="flex flex-none items-center gap-3 font-mono text-[0.6875rem] text-meter-fg">{parts}</span>;
}
