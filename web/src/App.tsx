import { useEffect } from 'react';
import { useStore } from 'react-redux';
import { selectConn, useAppSelector, type AppStore } from './store/store.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Footer } from './shell/Footer.tsx';
import { Panes } from './tabs/Panes.tsx';
import { TabStrip } from './tabs/TabStrip.tsx';
import { Header } from './shell/Header.tsx';
import { LeftStrip, RightStrip } from './shell/ToolStrip.tsx';
import { LoginRequired } from './shell/LoginRequired.tsx';
import { Stopped } from './shell/Stopped.tsx';
import { OneTab } from './shell/OneTab.tsx';
import { Toasts } from './shell/Toasts.tsx';
import { useFavicon } from './shell/Favicon.ts';
import { useSounds } from './shell/sounds.ts';
import { Slots, type Own } from './shell/Slots.tsx';
import { installKeymap } from './shell/keymap.ts';

// the frame's own parts among the plugins' (issue 511): the strips by the panels, the toasts among the overlays
const LEFT: readonly Own[] = [{ order: 20, render: LeftStrip }];
const RIGHT: readonly Own[] = [{ order: 20, render: RightStrip }];
const OVERLAYS: readonly Own[] = [{ order: 30, render: Toasts }];

export function App() {
  const store = useStore() as AppStore;
  useEffect(() => installKeymap(store), [store]);
  useFavicon();
  useSounds();
  // another tab owns the window (M7-15): the app stays mounted but inert under the overlay
  const conn = useAppSelector(selectConn);
  const blocked = conn === 'occupied' || conn === 'taken' || conn === 'unauthorized' || conn === 'stopped';
  return (
    <TooltipProvider>
      <div className="contents" inert={blocked}>
      <Header />
      {/*
        IntelliJ-style (R-M6-3): the strips and their panels run the full height under the header; an open panel is
        docked and narrows the middle column (tabs, panes, composer) instead of covering it.
      */}
      <div className="flex min-h-0 flex-1">
        <Slots at="panel.left" own={LEFT} />
        <div data-center className="flex min-w-0 flex-1 flex-col">
          <TabStrip />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Panes chat={<Slots at="chat" />} />
            <Slots at="panes" />
          </div>
          <Footer />
        </div>
        <Slots at="panel.right" own={RIGHT} />
      </div>
      <Slots at="overlay" own={OVERLAYS} />
      </div>
      <OneTab />
      <LoginRequired />
      <Stopped />
    </TooltipProvider>
  );
}
