import { useEffect } from 'react';
import { useStore } from 'react-redux';
import { selectConn, useAppSelector, type AppStore } from './core/store/store.ts';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { Panes } from './core/tabs/Panes.tsx';
import { TabStrip } from './core/tabs/TabStrip.tsx';
import { LoginRequired } from './core/shell/LoginRequired.tsx';
import { Stopped } from './core/shell/Stopped.tsx';
import { OneTab } from './core/shell/OneTab.tsx';
import { useFavicon } from './core/shell/Favicon.ts';
import { useSounds } from './core/shell/sounds.ts';
import { Slots } from './core/shell/Slots.tsx';
import { Frame } from './core/shell/Frame.tsx';
import { installKeymap } from './core/shell/keymap.ts';

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
      <Frame center={<>
        <TabStrip />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Panes chat={<Slots at="chat" />} />
          <Slots at="panes" />
        </div>
      </>} />
      </div>
      <OneTab />
      <LoginRequired />
      <Stopped />
    </TooltipProvider>
  );
}
