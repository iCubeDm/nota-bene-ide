import { useId } from 'react';

/**
 * The header's mark: public/icon.svg (the app icon, Plannotator's colours) drawn inline, so each theme paints it with
 * its own --logo-* tokens. The favicon stays its own small state-coloured disc (Favicon.ts).
 */
export function Logo({ className }: { className?: string }) {
  const id = useId().replace(/[^\w-]/g, ''); // a bare name: React's own ids carry characters url(#…) does not take
  const [tile, paper, note] = [`${id}t`, `${id}p`, `${id}n`];
  return (
    <svg id="logo" role="img" aria-label="Nota Bene" viewBox="0 0 512 512" className={className}>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--logo-tile)" /><stop offset="1" stopColor="var(--logo-tile-2)" />
        </linearGradient>
        <linearGradient id={paper} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--logo-paper)" /><stop offset="1" stopColor="var(--logo-paper-2)" />
        </linearGradient>
        <linearGradient id={note} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--logo-note)" /><stop offset="1" stopColor="var(--logo-note-2)" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="114" fill={`url(#${tile})`} />
      <rect x="3" y="3" width="506" height="506" rx="111" fill="none" stroke="var(--logo-paper)" strokeOpacity=".08" strokeWidth="6" />
      {/* the agent's reply; the middle line is highlighted, like a pending comment */}
      <path d="M132 84h232a64 64 0 0 1 64 64v150a64 64 0 0 1-64 64H210l-92 66 16-66h-2a64 64 0 0 1-64-64V148a64 64 0 0 1 64-64z" fill={`url(#${paper})`} />
      <rect x="120" y="140" width="252" height="30" rx="15" fill="var(--logo-ink)" opacity=".25" />
      <rect x="104" y="196" width="226" height="62" rx="16" fill="var(--logo-mark)" />
      <rect x="120" y="212" width="194" height="30" rx="15" fill="var(--logo-ink)" />
      <rect x="120" y="284" width="168" height="30" rx="15" fill="var(--logo-ink)" opacity=".25" />
      {/* the note in the margin: NB */}
      <circle cx="412" cy="227" r="74" fill="var(--logo-tile-2)" />
      <circle cx="412" cy="227" r="60" fill={`url(#${note})`} />
      <g fill="none" stroke="var(--logo-glyph)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round">
        <path d="M378 249V205l26 44V205" />
        <path d="M420 205h13a11 11 0 0 1 0 22h-13zM420 227h15a11 11 0 0 1 0 22h-15z" />
      </g>
    </svg>
  );
}
