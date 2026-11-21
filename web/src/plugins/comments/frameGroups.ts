import { isMediaAnchor, type Comment, type MediaAnchor } from '@nota-bene/shared';
import type { AnchorView } from '@/sdk';

/** Comments of one batch that mark the same picture: same file, ref, time, version and size. `idx` are 0-based batch positions. */
export type FrameGroup = { key: string; idx: number[] };

const frameKey = (a: MediaAnchor): string =>
  JSON.stringify([a.source.path, a.source.ref ?? null, a.time ?? null, a.version, a.width, a.height]);

/**
 * Groups of >= 2 pending media comments on one source frame (each with a stored frame image). A comment without a known
 * `version` never groups (two different contents of one file could look alike). `key` = batch position + comment id of
 * every member, so a changed or renumbered batch never matches a stale composite (its badges carry those numbers).
 */
export function frameGroups(pending: Comment[]): FrameGroup[] {
  const by = new Map<string, number[]>();
  pending.forEach((c, i) => {
    // no shapes (the whole picture, issue 494): no badge to point at in a shared frame
    if (!isMediaAnchor(c.anchor) || !c.anchor.shapes.length || c.anchor.version === undefined || !c.images?.[0]) return;
    const k = frameKey(c.anchor);
    by.set(k, [...(by.get(k) ?? []), i]);
  });
  return [...by.values()].filter((idx) => idx.length > 1).map((idx) => ({ key: idx.map((i) => `${i + 1}:${pending[i].id}`).join(','), idx }));
}

/**
 * One composite per group, made by the media plugin (`AnchorView.composite`). Returns group key → attachment id. Never
 * rejects: a group that fails is left out (warned once) and its comments go with their own frames.
 */
export async function buildComposites(pending: Comment[], groups: FrameGroup[], draw: NonNullable<AnchorView['composite']>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let warned = false;
  for (const g of groups) {
    try {
      out.set(g.key, await draw(g.idx.map((i) => ({ n: i + 1, comment: pending[i] }))));
    } catch (e) {
      if (!warned) console.warn('composite image failed, sending the frames separately:', e);
      warned = true;
    }
  }
  return out;
}
