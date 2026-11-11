import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { ago } from '@/controls/SessionPicker.tsx';
import { useT } from '@/i18n/index.ts';
import { withKey } from '@/shell/keymap.ts';
import { useAppSelector } from '@/store/store.ts';
import { searchPrompts, selectPromptItems } from './history.ts';
import { promptHistoryModal } from './historyModal.ts';

/** how many rows an empty query draws (the whole history can hold a thousand) */
const SHOWN_MAX = 200;

/**
 * The prompt history as a searchable list (Alt+H) above the composer, running right from its button left of the field: newest first, a filter box on top
 * (substring hits, then fuzzy ones), ↑↓ Enter Esc. Choosing a prompt puts its text in the draft; it is never sent from here.
 */
export function PromptHistory({ onPick, onClosed }: { onPick: (text: string) => void; onClosed: () => void }) {
  const t = useT();
  const open = useSyncExternalStore(promptHistoryModal.subscribe, promptHistoryModal.get);
  const items = useAppSelector(selectPromptItems);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const picked = useRef(false);
  // a recording hides the button: the list must not wait open behind it, nor pop up when the button returns
  useEffect(() => {
    promptHistoryModal.close();
    return () => promptHistoryModal.close();
  }, []);
  useEffect(() => {
    if (open) { setQ(''); setAt(0); picked.current = false; }
  }, [open]);

  const shown = useMemo(() => searchPrompts(items, q).slice(0, SHOWN_MAX), [items, q]);
  const cur = Math.max(0, Math.min(at, shown.length - 1));
  const pick = (text: string | undefined) => {
    if (text === undefined) return;
    picked.current = true;
    promptHistoryModal.close();
    onPick(text);
  };

  return (
    <Popover open={open} onOpenChange={(o) => (o ? promptHistoryModal.open() : promptHistoryModal.close())}>
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="prompt-history"
                  disabled={!items.length}
                  aria-label={t('promptHistory')}
                  aria-expanded={open}
                  onClick={() => (open ? promptHistoryModal.close() : promptHistoryModal.open())}
                  className="h-10 bg-muted px-2.5 text-muted-foreground hover:text-foreground"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5M12 7v5l3 2" />
                  </svg>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="whitespace-pre-line">{withKey(t('promptHistory'), 'hk_promptHistory')}</TooltipContent>
          </Tooltip>
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        data-nb-modal=""
        aria-label={t('promptHistory')}
        // the button toggles it: its own pointerdown must not dismiss first (the click would reopen)
        onInteractOutside={(e) => { if ((e.target as HTMLElement | null)?.closest?.('[data-testid="prompt-history"]')) e.preventDefault(); }}
        onOpenAutoFocus={(e) => { e.preventDefault(); input.current?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={(e) => { e.preventDefault(); if (!picked.current) onClosed(); }}
        className="flex max-h-[min(60vh,420px)] w-[min(560px,calc(100vw-2rem))] flex-col p-1.5"
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(shown.length - 1, cur + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(0, cur - 1)); }
            else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); pick(shown[cur]?.text); }
          }}
          placeholder={t('promptHistoryFilter')}
          aria-label={t('promptHistoryFilter')}
          role="combobox"
          aria-expanded
          aria-controls="nb-prompts-list"
          aria-activedescendant={shown.length ? `nb-prompts-opt-${cur}` : undefined}
          className="mx-1 mb-1 flex-none rounded-md border border-border-soft bg-transparent px-2.5 py-1.5 text-[0.8125rem] text-foreground outline-none focus-visible:border-input-focus focus-visible:ring-2 focus-visible:ring-input-ring"
        />
        <div id="nb-prompts-list" role="listbox" aria-label={t('promptHistory')} className="min-h-0 overflow-auto">
          {!shown.length && (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">{q.trim() ? t('promptHistoryNone') : t('promptHistoryEmpty')}</div>
          )}
          {shown.map((x, i) => (
            <button
              key={x.id}
              type="button"
              role="option"
              id={`nb-prompts-opt-${i}`}
              tabIndex={-1}
              aria-selected={i === cur}
              onMouseMove={() => setAt(i)}
              onClick={() => pick(x.text)}
              ref={(el) => { if (i === cur) el?.scrollIntoView?.({ block: 'nearest' }); }}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[0.78125rem] ${i === cur ? 'bg-muted text-foreground' : 'text-foreground/85'}`}
            >
              <span className="line-clamp-2 min-w-0 flex-1 break-words whitespace-pre-line">{x.text}</span>
              {x.src === 'voice' && (
                <svg role="img" aria-label={t('promptHistoryVoice')} viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-none text-muted-foreground">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              )}
              <span className="flex-none text-[0.65625rem] text-muted-foreground">{ago(x.ts)}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
