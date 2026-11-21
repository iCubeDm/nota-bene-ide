import type { ReactNode } from 'react';

/** The app's line icons on a 24-unit grid (the tabs', the strips' and the menus'), drawn in the current colour. */
export const Svg = ({ children, size = 14 }: { children: ReactNode; size?: number }) => (
  <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width={size} height={size} className="flex-none">{children}</svg>
);
export const ICONS = {
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  dir: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  comments: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M8 9h8M8 13h5" /></>,
  shell: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></>,
  agent: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  diagram: <><rect x="3" y="3" width="7" height="6" rx="1" /><rect x="14" y="15" width="7" height="6" rx="1" /><path d="M6.5 9v3.5a2 2 0 0 0 2 2H14M10 18H7a1 1 0 0 1-1-1" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" /></>,
  changes: <><path d="M12 4v7M8.5 7.5h7M8.5 17h7" /><rect x="3" y="2.5" width="18" height="19" rx="2" /></>,
  log: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M16.2 10a8 8 0 0 1-8.2 7" /></>,
  usage: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  // remote access: a phone with a signal
  remote: <><rect x="5" y="7" width="9" height="15" rx="2" /><path d="M9 18.5h1M17 7.5a4 4 0 0 1 0 5M19.5 5a7.5 7.5 0 0 1 0 10" /></>,
  // the interface scale: a large and a small A
  textSize: <path d="M3 19 8.5 5 14 19M5.3 14h6.4M15 19l3-7.5 3 7.5M16.1 16.5h3.8" />,
  // the sessions history: a clock with a counter-clockwise arrow
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  restart: <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />,
  power: <path d="M12 3v9M18.4 6.6a9 9 0 1 1-12.8 0" />,
  // another computer (issue 297): lucide's laptop
  laptop: <><path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.946 1.45H3.666a1 1 0 0 1-.946-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" /><path d="M20.054 15.987H3.946" /></>,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7.5" r="1" /><circle cx="15" cy="7.5" r="1" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
};

/** An archive box: a lid over a box with a slot. */
export const ArchiveIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="inline-block align-[-1px]">
    <rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
  </svg>
);
