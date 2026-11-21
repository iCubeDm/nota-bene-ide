import type { ServerEvent } from '@nota-bene/shared';

type Chunk = Extract<ServerEvent, { kind: 'agent' }> & { e: { t: 'message-chunk'; text: string } };
const isChunk = (ev: ServerEvent): ev is Chunk => ev.kind === 'agent' && ev.e.t === 'message-chunk';

/**
 * The streamed chunks that arrive within one animation frame reach `deliver` as one chunk, their texts joined: the feed
 * renders once a frame, not once a token (issue 471). Any other event delivers the pending chunk first, so the order stays.
 */
export function coalesceChunks(
  deliver: (ev: ServerEvent) => void,
  frame: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
): (ev: ServerEvent) => void {
  let pending: Chunk | null = null;
  let id = 0;
  const flush = () => {
    const p = pending;
    pending = null;
    if (p) deliver(p);
  };
  return (ev) => {
    if (isChunk(ev)) {
      if (pending) pending = { ...pending, e: { ...pending.e, text: pending.e.text + ev.e.text } };
      else {
        pending = ev;
        id = frame(flush);
      }
      return;
    }
    if (pending) {
      cancel(id);
      flush();
    }
    deliver(ev);
  };
}
