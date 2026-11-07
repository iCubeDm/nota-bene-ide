import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { useT } from '@/i18n/index.ts';
import { apiFetch } from '@/net/auth.ts';
import { Markdown } from '@/feed/Markdown.tsx';

const SEEN_KEY = 'nb.updateSeen';
const RECHECK = 'nb-update-recheck';

/** The switch in Settings changed: the notice follows at once, not on the next focus. */
export const recheckUpdate = () => window.dispatchEvent(new Event(RECHECK));

/** "↑ 1.3.0" in the header while a newer version than the running one is on npm. Later hides it until the next version. */
export function UpdateNotice() {
  const t = useT();
  const [update, setUpdate] = useState<{ current: string; latest: string } | null>(null);
  const [seen, setSeen] = useState(() => localStorage.getItem(SEEN_KEY));
  // what the newer version changes, by version: asked when the popover first opens for it
  const [changes, setChanges] = useState<{ v: string; text: string } | null>(null);

  useEffect(() => {
    const ask = () => {
      void apiFetch('/system/update')
        .then(async (r) => (r.ok ? ((await r.json()) as { current: string; latest: string | null }) : null))
        .then((u) => { setUpdate(u?.latest ? { current: u.current, latest: u.latest } : null); }, () => {});
    };
    ask();
    window.addEventListener('focus', ask); // the server keeps the answer, so this asks npm no more often
    window.addEventListener(RECHECK, ask);
    return () => {
      window.removeEventListener('focus', ask);
      window.removeEventListener(RECHECK, ask);
    };
  }, []);

  if (!update || update.latest === seen) return null;
  const open = (on: boolean) => {
    if (!on || changes?.v === update.latest) return;
    const v = update.latest;
    void apiFetch('/system/update/changes')
      .then(async (r) => (r.ok ? ((await r.json()) as { text: string | null }).text : null))
      .then((text) => { if (text) setChanges({ v, text }); }, () => {});
  };
  const later = () => {
    localStorage.setItem(SEEN_KEY, update.latest);
    setSeen(update.latest);
  };
  return (
    <Popover onOpenChange={open}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id="updateBtn"
          title={t('updateTitle', update.latest)}
          className="flex-none rounded border border-primary px-1.5 py-px font-mono text-[0.6875rem] text-link hover:bg-primary/10"
        >
          ↑ {update.latest}
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={t('updateTitle', update.latest)} collisionPadding={8} className="grid w-[420px] gap-2 p-3 text-xs">
        <b className="text-[0.8125rem] font-semibold text-foreground">{t('updateTitle', update.latest)}</b>
        <span className="text-muted-foreground">{t('updateYours', update.current)}</span>
        <code className="rounded bg-muted px-2 py-1 font-mono text-[0.6875rem] text-foreground select-all">npm i -g nota-bene-ide@{update.latest}</code>
        <span className="text-muted-foreground">{t('updateHow')}</span>
        {changes?.v === update.latest && (
          <section aria-label={t('updateChanges')} className="grid gap-1 border-t border-border-soft pt-2">
            <b className="font-semibold text-foreground">{t('updateChanges')}</b>
            {/* CHANGELOG is written in English: it is the project's text, not the interface's */}
            <div data-testid="update-changes" className="max-h-[45vh] overflow-y-auto pr-1 [&_.md]:text-xs [&_.md_h2]:text-[0.8125rem]">
              <Markdown text={changes.text} final noHtml />
            </div>
          </section>
        )}
        <span className="flex items-center justify-between pt-1">
          <a
            href={`https://github.com/iCubeDm/nota-bene-ide/releases/tag/v${update.latest}`}
            target="_blank"
            rel="noreferrer"
            className="text-link hover:underline"
          >
            {t('updateNotes')}
          </a>
          <button type="button" onClick={later} className="rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            {t('updateLater')}
          </button>
        </span>
      </PopoverContent>
    </Popover>
  );
}
