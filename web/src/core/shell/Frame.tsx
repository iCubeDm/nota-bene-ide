import type { ReactNode } from 'react';
import { Footer } from './Footer.tsx';
import { Header } from './Header.tsx';
import { LeftStrip, RightStrip } from './ToolStrip.tsx';
import { Toasts } from './Toasts.tsx';
import { Slots, type Own } from './Slots.tsx';

// the frame's own parts among the plugins' (issue 511): the strips by the panels, the toasts among the overlays
const LEFT: readonly Own[] = [{ order: 20, render: LeftStrip }];
const RIGHT: readonly Own[] = [{ order: 20, render: RightStrip }];
const OVERLAYS: readonly Own[] = [{ order: 30, render: Toasts }];

/**
 * The app's frame, an agent's page and the server's home page alike (issue 651): the header, the panels and their strips
 * on both sides, `center` over the footer, the overlays. IntelliJ-style (R-M6-3): the strips and their panels run the
 * full height under the header; an open panel is docked and narrows the middle column instead of covering it.
 */
export function Frame({ center }: { center: ReactNode }) {
  return (
    <>
      <Header />
      <div className="flex min-h-0 flex-1">
        <Slots at="panel.left" own={LEFT} />
        <div data-center className="flex min-w-0 flex-1 flex-col">
          {center}
          <Footer />
        </div>
        <Slots at="panel.right" own={RIGHT} />
      </div>
      <Slots at="overlay" own={OVERLAYS} />
    </>
  );
}
