import { useRef, useState } from 'react';
import type { AgentEffort as EffortLevel, ModelOption } from '@nota-bene/shared';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { selectStats } from '@/stats/slice.ts';
import { selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { pickModel, selectModel, selectModelSwitchable, selectModels, selectSwitching } from './slice.ts';

/**
 * The row for the model id in use. The CLI reports resolved ids, the list has aliases, and two rows can resolve to one
 * id (`default` and `opus`): an alias we set wins, a resolved id takes the first row that has it.
 */
const rowFor = (models: ModelOption[], id: string | null | undefined): ModelOption | undefined => {
  if (!id) return undefined;
  const exact = (x: string) => models.find((o) => o.value === x) ?? models.find((o) => o.resolved === x);
  // a session id may carry a context suffix (`claude-opus-5-5[1m]`): then the bare id
  return exact(id) ?? exact(id.replace(/\[[^\]]*\]$/, ''));
};

/** the aliases (`sonnet`) are the everyday list; explicit ids (`claude-sonnet-5`) go under "Other versions" */
const isAlias = (o: ModelOption) => !o.value.startsWith('claude-');
const resolvedOf = (o: ModelOption) => o.resolved ?? o.value;
/** a router's ids carry their provider (`anthropic/claude-opus-5`, `google/gemini-3-pro`): the list is grouped by it */
const providerOf = (o: ModelOption) => (o.value.includes('/') ? o.value.slice(0, o.value.indexOf('/')) : '');
/** from this many rows on the list has a search field */
const SEARCH_MIN = 10;
/** every word of the query in the name, the id or the description */
const matches = (o: ModelOption, q: string) => {
  const hay = `${o.name} ${o.value} ${o.description}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

/** the rows by provider, in list order, the provider of the model in use first */
function byProvider(models: ModelOption[], current: ModelOption | undefined): [string, ModelOption[]][] {
  const groups = new Map<string, ModelOption[]>();
  if (current) groups.set(providerOf(current), []);
  for (const o of models) {
    const k = providerOf(o);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  return [...groups].filter(([, rows]) => rows.length > 0);
}

/**
 * The model in the header. One compact row per model, one effort row for the current model below the list. Choosing
 * applies from the next reply. A model change drops the prompt cache, so one line at the bottom says what the next
 * reply will re-read (the context meter's tokens), once the session has had a turn; an effort change keeps the cache.
 */
export function ModelPill() {
  const t = useT();
  const dispatch = useAppDispatch();
  const cur = useAppSelector(selectModel);
  const models = useAppSelector(selectModels);
  const switching = useAppSelector(selectSwitching);
  const switchable = useAppSelector(selectModelSwitchable);
  const used = useAppSelector(selectStats)?.context?.used ?? 0;
  const sessionModel = useAppSelector(selectSession)?.model ?? null;
  const id = cur?.model ?? sessionModel;
  const current = rowFor(models, id);
  // no row for the session's model: effort stays selectable with the default row's levels
  const efforts = current ? current.efforts : id ? (models.find((o) => o.value === 'default' && o.efforts) ?? models.find((o) => o.efforts))?.efforts : undefined;
  const [more, setMore] = useState(false);
  const [hover, setHover] = useState<ModelOption | null>(null);
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const hadTurn = useAppSelector((st) => st.feed.earlier > 0 || st.feed.items.some((it) => it.kind === 'user'));
  if (!id && !switchable) return null; // nothing known yet
  const label = (current?.name ?? id ?? t('modelUnknown')) + (cur?.effort ? ` · ${t(`effort_${cur.effort}`)}` : '');
  const trigger = (
    <button
      type="button"
      aria-label={t('modelTip')}
      disabled={switching || !switchable}
      className="inline-flex h-[24px] items-center rounded-full border border-border-soft bg-transparent px-2.5 font-mono text-[0.6875rem] text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-70"
    >
      {/* the model's name is the trigger's mark: it takes the model accent (the theme's own text colour in Plannotator) */}
      <span className="text-accent-model">{label}</span>
    </button>
  );
  if (!switchable) return trigger;
  const kTokens = Math.max(1, Math.round(used / 1000));
  const pick = (o: ModelOption, effort?: EffortLevel) => {
    if (o === current && effort === cur?.effort) return;
    // the current model keeps its exact session id (`[1m]` included): an effort change is not a model switch
    void dispatch(pickModel(o === current && id ? id : o.value, effort));
  };
  const pickEffort = (e: EffortLevel) => {
    if (e === cur?.effort) return;
    void dispatch(pickModel(id ?? current?.value ?? '', e));
  };
  const searchable = models.length >= SEARCH_MIN;
  const shown = searchable && query.trim() ? models.filter((o) => matches(o, query)) : models;
  const grouped = models.some((o) => providerOf(o) !== '');
  const others = grouped ? [] : shown.filter((o) => !isAlias(o));
  const showMore = more || !!query.trim() || (!!current && !isAlias(current));
  // a model change drops the cache; the same resolved id keeps it. Nothing to re-read before the first turn.
  const differs = (o: ModelOption) => (current ? resolvedOf(o) !== resolvedOf(current) : true);
  const warn = hadTurn && used > 0 && (hover ? differs(hover) : models.some(differs));
  const row = (o: ModelOption) => {
    const here = o === current;
    return (
      <DropdownMenuItem
        key={o.value}
        aria-current={here || undefined}
        onFocus={() => setHover(o)}
        onPointerEnter={() => setHover(o)}
        onSelect={() => pick(o, here ? cur?.effort : cur?.effort && o.efforts?.includes(cur.effort) ? cur.effort : undefined)}
        className={`flex items-baseline gap-2 px-2.5 py-1.5 ${here ? 'bg-muted' : ''}`}
      >
        <b className="shrink-0 text-[0.8125rem] font-medium">{o.name}</b>
        <span className="min-w-0 flex-1 truncate text-[0.71875rem] text-muted-foreground">{o.description}</span>
        <span aria-hidden className="w-3 shrink-0 text-[0.75rem]">{here ? '✓' : ''}</span>
      </DropdownMenuItem>
    );
  };
  return (
    <DropdownMenu
      onOpenChange={(o) => {
        if (!o) setQuery('');
        // the menu focuses itself on open; a long list wants the search field instead
        else if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('modelTip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="bottom"
        align="end"
        // a long list (a router's dozens of models) scrolls inside the menu; search and effort rows stay in place
        className="flex max-h-[var(--radix-dropdown-menu-content-available-height)] w-[320px] flex-col"
        onPointerLeave={() => setHover(null)}
        // Esc clears a query first, then closes
        onEscapeKeyDown={(e) => { if (query) { e.preventDefault(); setQuery(''); } }}
      >
        {searchable && (
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={t('modelSearch')}
            aria-label={t('modelSearch')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
                return;
              }
              if (e.key !== 'Escape') e.stopPropagation(); // typed letters are the query, not the menu's typeahead
            }}
            className="mx-1 mt-0.5 mb-1 h-7 shrink-0 rounded-md border border-border-soft bg-transparent px-2 text-[0.75rem] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-focus-border focus-visible:ring-2 focus-visible:ring-input-ring"
          />
        )}
        <div ref={listRef} data-testid="model-list" className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && <p className="m-0 px-2.5 py-1.5 text-[0.75rem] text-muted-foreground">{t('modelNone')}</p>}
        {grouped
          ? byProvider(shown, current).map(([p, rows]) => (
              <div key={p} role={p ? 'group' : undefined} aria-label={p || undefined}>
                {p && <div aria-hidden className="px-2.5 pt-1.5 pb-0.5 text-[0.6875rem] font-medium text-muted-foreground">{p}</div>}
                {rows.map(row)}
              </div>
            ))
          : shown.filter(isAlias).map(row)}
        {others.length > 0 && (
          <>
            <DropdownMenuItem
              aria-expanded={showMore}
              onSelect={(e) => { e.preventDefault(); setMore(!more); }}
              className="px-2.5 py-1.5 text-[0.75rem] text-muted-foreground"
            >
              {showMore ? '▾' : '▸'} {t('modelOthers')}
            </DropdownMenuItem>
            {showMore && others.map(row)}
          </>
        )}
        </div>
        {efforts && (
          <div role="group" aria-label={t('effortLabel')} className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border-soft px-2.5 pb-1 pt-1.5">
            <span className="mr-1 text-[0.6875rem] text-muted-foreground">{t('effortLabel')}</span>
            {efforts.map((e) => (
              <DropdownMenuItem
                key={e}
                aria-current={cur?.effort === e || undefined}
                onFocus={() => setHover(null)}
                onSelect={() => pickEffort(e)}
                className={`inline-flex h-[22px] w-auto items-center rounded-full border border-border-soft px-2 py-0 text-[0.6875rem] ${cur?.effort === e ? 'bg-muted font-medium' : ''}`}
              >
                {t(`effort_${e}`)}
              </DropdownMenuItem>
            ))}
          </div>
        )}
        {warn && <p data-testid="cache-warn" className="m-0 shrink-0 border-t border-border-soft px-2.5 pb-1.5 pt-1.5 text-[0.71875rem] leading-snug text-warn">{t('modelCacheWarn', kTokens)}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
