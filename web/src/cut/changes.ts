// What a change to the edit's file from outside (the agent) did to its clips (issue 412), by clip id: the timeline
// highlights the added and changed clips for a moment and shows a ghost where a removed one was.
import type { CSSProperties } from 'react';
import type { Cut, CutClip } from '@nota-bene/shared/cut';

/** How long the highlight of an outside change lasts, ms. */
export const FLASH_MS = 2000;

/** The highlight's length as the CSS variable its animations read (theme.css, nb-cut-flash). */
export const flashStyle = { '--nb-flash-ms': `${FLASH_MS}ms` } as CSSProperties;

export type CutChanges = {
  /** clips with an id the edit had not: in the new edit's order */
  added: string[];
  /** clips whose any field differs: moved, trimmed, another track, gain, fades, placement; in the new edit's order */
  changed: string[];
  /** clips whose id is gone, as they were (where they stood) */
  removed: CutClip[];
};

/** A change being shown: `gen` counts them, so a new one starts its fade again. */
export type CutFlash = CutChanges & { gen: number };

// a value as JSON with its object keys sorted: a file written with the keys in another order is the same clip;
// an undefined field is not in the file, as JSON drops it
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

/** The clips added, changed and removed from `before` to `after`; the tracks and the clips' order are not compared. */
export function cutChanges(before: Cut, after: Cut): CutChanges {
  const was = new Map(before.clips.map((c) => [c.id, c]));
  const now = new Set(after.clips.map((c) => c.id));
  const added: string[] = [];
  const changed: string[] = [];
  for (const c of after.clips) {
    const old = was.get(c.id);
    if (!old) added.push(c.id);
    else if (canon(old) !== canon(c)) changed.push(c.id);
  }
  return { added, changed, removed: before.clips.filter((c) => !now.has(c.id)) };
}

export const isNoChange = (d: CutChanges): boolean => !d.added.length && !d.changed.length && !d.removed.length;
