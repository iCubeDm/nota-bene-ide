import { useT } from '@/i18n/index.ts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { cancelCompact, selectCompactPending } from './slice.ts';

/** Issue 499: a compaction ordered while the agent works waits for the next pause; the chip says so and offers Cancel. */
export function CompactPending() {
  const t = useT();
  const d = useAppDispatch();
  if (!useAppSelector(selectCompactPending)) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" id="compactPendingChip" className="cursor-pointer whitespace-nowrap rounded-md border border-warn px-2 py-0.5 text-[0.6875rem] font-medium text-warn hover:text-foreground">
          {t('compactPending')}
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={t('compactPending')} collisionPadding={8} className="grid w-[320px] gap-2 p-3 text-xs">
        <b className="text-[0.8125rem] font-semibold text-foreground">{t('compactPending')}</b>
        <span className="text-muted-foreground">{t('compactPendingBody')}</span>
        <span className="flex justify-end pt-1">
          <button type="button" onClick={() => void d(cancelCompact())} className="rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">{t('compactCancel')}</button>
        </span>
      </PopoverContent>
    </Popover>
  );
}
