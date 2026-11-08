import { useT } from '@/i18n/index.ts';
import { selectConn, useAppSelector } from '@/store/store.ts';

/**
 * This tab stopped its own window (the ↻ menu's Stop window). The server is gone and nothing reconnects; a page cannot close
 * a tab the launcher opened, so it says so and leaves the tab to the user. `/nb` or `nota-bene` opens the window again.
 */
export function Stopped() {
  const t = useT();
  const conn = useAppSelector(selectConn);
  if (conn !== 'stopped') return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stopped-title"
      data-testid="stopped"
      className="fixed inset-0 z-[100] grid place-items-center bg-background/95"
    >
      <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
        <h1 id="stopped-title" className="text-lg font-semibold text-foreground">{t('stoppedTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('stoppedBody')}</p>
      </div>
    </div>
  );
}
