import { expect, it, vi } from 'vitest';
import { track } from './track.ts';

it('keeps the last 200 events in memory and sends nothing', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    for (let i = 0; i < 205; i++) track('open', { n: i, ok: true });
    const recent = track.recent();
    expect(recent).toHaveLength(200);
    expect(recent[0]).toMatchObject({ name: 'open', props: { n: 5, ok: true } });
    expect(recent.at(-1)).toMatchObject({ name: 'open', props: { n: 204 } });
    track('bare');
    expect(track.recent().at(-1)).toEqual({ name: 'bare', at: expect.any(Number) });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
