import type { ReactNode } from 'react';

/** The pane of a view with one tab (Settings, Usage, Remote): scrolled, hidden while another tab is active, and not a place to comment on. */
export const ViewPane = ({ kind, active, children }: { kind: string; active: boolean; children: ReactNode }) => (
  <div data-pane={kind} data-anchor-skip hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">
    {children}
  </div>
);
