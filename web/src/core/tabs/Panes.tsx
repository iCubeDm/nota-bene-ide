import type { ReactNode } from 'react';
import { useAppSelector, useRegistry } from '@/core/store/store.ts';
import { tabView } from '@/sdk/registry.ts';
import { selectTabs, type Tab } from './slice.ts';

/**
 * All panes stay mounted; the inactive ones are `hidden`. The chat pane is therefore the same element
 * across tab switches (comment anchors, HighlightLayer, SelectionButton's scroll listener and the feed autoscroll rely on it).
 * Every other tab's pane is its view's (issue 511), which remounts on `rootGen` where another root means another one.
 */
export function Panes({ chat }: { chat: ReactNode }) {
  const { open, active, rootGen } = useAppSelector(selectTabs);
  return (
    <>
      <main data-chat-pane data-pane="chat" hidden={active !== 'chat'} className="grid-pane relative min-h-0 flex-1 overflow-auto">
        {chat}
      </main>
      {open.map((tab) => tab.kind !== 'chat' && <Pane key={tab.id} tab={tab} active={active === tab.id} rootGen={rootGen} />)}
    </>
  );
}

function Pane({ tab, active, rootGen }: { tab: Tab; active: boolean; rootGen: number }) {
  const Render = tabView(useRegistry(), tab)?.render;
  return Render ? <Render tab={tab} active={active} rootGen={rootGen} /> : null;
}
