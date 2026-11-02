import { useT } from '@/i18n/index.ts';

/** The branch chip of a view or a tab of another source (M3-16): read-only. */
export function SourceChip({ name }: { name: string }) {
  const t = useT();
  return (
    <span data-src-chip title={t('readOnly')} className="max-w-[120px] flex-none truncate rounded bg-muted px-1 font-mono text-[10.5px] leading-4 text-muted-foreground">
      {name}
    </span>
  );
}
