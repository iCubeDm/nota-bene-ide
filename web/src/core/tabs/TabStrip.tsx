import { useT, useStored } from '@/sdk';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { shallowEqual } from 'react-redux';
import { useAppDispatch, useAppSelector, useMedia, useRegistry } from '@/core/store/store.ts';
import { tabLabel, tabView } from '@/sdk/registry.ts';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/core/components/ui/context-menu.tsx';
import { activate, closeAll, closeOthers, closeRight, closeTab, moveTab, selectTabs, type Tab } from './slice.ts';
import { DROP_MARK, useDragOrder } from '../lib/dragOrder.ts';
import { ChatTabContext } from './chatTab.ts';
import { TabsMenu } from './TabsMenu.tsx';
import { ICONS, Svg } from '../components/icons.tsx';
import { focusTab } from './focus.ts';
import { Slots } from '../shell/Slots.tsx';

/** A tab's icon: its view's (a file its type's), else its kind's. */
export function TabIcon({ tab }: { tab: Tab }) {
  const Icon = tabView(useRegistry(), tab)?.Icon;
  return Icon ? <Icon tab={tab} /> : <Svg>{ICONS[tab.kind as keyof typeof ICONS]}</Svg>;
}

/** The open tabs' labels, in strip order, from their views (issue 469): the strip and its menu name a tab alike. */
function useLabels(open: Tab[]): string[] {
  const t = useT();
  const r = useRegistry();
  return useAppSelector((s) => open.map((tab) => tabLabel(r, tab, t, s)), shallowEqual);
}

/** A tab, no tooltip (issue 463): its label says it. Its view adds its own parts (a chip, a badge, a picker, an edit). */
function TabItem({ tab, label, active, last, playing, end }: { tab: Tab; label: string; active: boolean; last: boolean; playing: boolean; end?: ReactNode }) {
  const t = useT();
  const d = useAppDispatch();
  const view = tabView(useRegistry(), tab);
  const edit = view?.edit;
  const canEdit = useAppSelector((s) => !!edit?.when(s));
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const isChat = tab.kind === 'chat';
  const Extra = view?.Extra;
  const drag = useDragOrder('application/x-nb-tab', tab.id, (id, to, after) => d(moveTab({ id: id as Tab['id'], to: to as Tab['id'], after })), !isChat && !renaming);
  return (
    <ContextMenu>
      {/* off while renaming: the input keeps the browser's own menu, for a paste */}
      <ContextMenuTrigger asChild disabled={renaming}>
        <div
          role="tab"
          tabIndex={active ? 0 : -1}
          aria-selected={active}
          data-tab={tab.id}
          data-playing={playing || undefined}
          {...drag}
          onClick={() => d(activate(tab.id))}
          onAuxClick={(e) => {
            if (e.button === 1 && !isChat) { e.preventDefault(); d(closeTab(tab.id)); }
          }}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); d(activate(tab.id)); }
          }}
          className={`group relative flex h-7 max-w-[260px] flex-none cursor-pointer items-center gap-1.5 rounded-lg pr-1.5 pl-2.5 text-[0.78125rem] font-medium whitespace-nowrap hover:bg-muted/50 hover:text-foreground ${DROP_MARK} ${active ? 'bg-tab-on-bg text-tab-on-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-tab-line' : 'text-muted-foreground'}`}
        >
          <span className="hidden size-1.5 flex-none animate-pulse rounded-full bg-primary group-data-[playing=true]:inline-block" />
          <TabIcon tab={tab} />
          {renaming && edit && canEdit
            ? <edit.Input ref={input} tab={tab} done={(back) => { setRenaming(false); if (back) focusTab(tab.id); }} />
            : <span className="truncate">{label}</span>}
          {Extra && <Extra tab={tab} />}
          {!isChat && (
            <button
              type="button"
              aria-label={t('close')}
              onClick={(e) => { e.stopPropagation(); d(closeTab(tab.id)); }}
              className="grid size-[18px] place-items-center rounded-[5px] opacity-50 hover:bg-muted hover:opacity-100"
            >
              <Svg size={10}><path d="M18 6 6 18M6 6l12 12" /></Svg>
            </button>
          )}
          {end}
        </div>
      </ContextMenuTrigger>
      {/* the menu gives the focus back when it closes: to the title being edited, if that is what was picked */}
      <ContextMenuContent onCloseAutoFocus={(e) => { if (input.current) { e.preventDefault(); input.current.focus(); } }}>
        {edit && canEdit && (
          <>
            <ContextMenuItem onSelect={() => setRenaming(true)}>{t(edit.label)}</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {!isChat && <ContextMenuItem onSelect={() => d(closeTab(tab.id))}>{t('close')}</ContextMenuItem>}
        <ContextMenuItem onSelect={() => d(closeOthers(tab.id))}>{t('closeOthers')}</ContextMenuItem>
        {!isChat && !last && <ContextMenuItem onSelect={() => d(closeRight(tab.id))}>{t('closeRight')}</ContextMenuItem>}
        <ContextMenuItem onSelect={() => d(closeAll())}>{t('closeAll')}</ContextMenuItem>
        {tab.kind === 'file' && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(tab.path)}>{t('copyPath')}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Tab overflow, IntelliJ-style (M6-12): no scrollbar; the wheel scrolls the strip sideways, the active tab is scrolled
 * into view, and "▾" at the right end lists the hidden tabs and all tabs.
 */
export function TabStrip() {
  const { open, active } = useAppSelector(selectTabs);
  const media = useMedia();
  const playing = useStored({ subscribe: media.subscribe, get: () => media.playing() });
  const strip = useRef<HTMLDivElement>(null);
  const names = useLabels(open);
  const labels = new Map(open.map((tab, i) => [tab.id, names[i]!]));
  const placed = !!useRegistry().slots.get('tabs.chat')?.length;
  // after a switch, an open or a close (not on a resize: that would undo the user's own scroll of the strip)
  useEffect(() => {
    [...(strip.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])].find((n) => n.dataset.tab === active)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active, open.length]);
  return (
    <div className="flex h-10 flex-none items-center gap-1 border-b border-border-soft bg-chrome pr-1.5 pl-2">
      <div
        ref={strip}
        role="tablist"
        onWheel={(e) => {
          // a vertical wheel scrolls the strip sideways (a trackpad's own horizontal swipe already does)
          // deltaMode 1 (lines, Firefox's mouse wheel): about 16 px a line
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
        }}
        className="nb-no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {open.map((tab, i) => (
          // the dot marks a background tab that still plays; the active tab shows its own player
          <Fragment key={tab.id}>
            {tab.kind === 'chat' && placed
              ? <ChatTabContext.Provider value={(end) => <TabItem tab={tab} label={names[i]!} active={tab.id === active} last={i === open.length - 1} playing={tab.id === playing && tab.id !== active} end={end} />}><Slots at="tabs.chat" /></ChatTabContext.Provider>
              : <TabItem tab={tab} label={names[i]!} active={tab.id === active} last={i === open.length - 1} playing={tab.id === playing && tab.id !== active} />}
          </Fragment>
        ))}
      </div>
      <TabsMenu strip={strip} labels={labels} />
    </div>
  );
}
