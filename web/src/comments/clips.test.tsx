import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { resetPlayer } from '@/voice/player.ts';
import { CommentCard } from './CommentCard.tsx';

class FakeAudio {
  static all: FakeAudio[] = [];
  paused = true; ended = false; currentTime = 0; preload = '';
  src: string;
  constructor(src: string) { this.src = src; FakeAudio.all.push(this); }
  addEventListener() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}
beforeEach(() => { setLang('en'); FakeAudio.all = []; vi.stubGlobal('Audio', FakeAudio); });
afterEach(() => { cleanup(); resetPlayer(); vi.unstubAllGlobals(); });

const wave = Array.from({ length: 48 }, (_, i) => i % 32);
const clip = (n: number, text: string) => ({ id: String(n).repeat(64), ms: 3000 * n, wave, text });
const comment = (o: Partial<Comment> = {}): Comment => ({
  id: 'c1', anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 5, quote: 'hello', prefix: '', suffix: '' },
  text: 'typed note', status: 'pending', createdAt: 1, voice: [clip(1, 'first words'), clip(2, 'second words')], ...o,
});

it('a comment card lists its clips with play and the transcript, in order, with no delete', () => {
  const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [comment()] })));
  render(<Provider store={store}><TooltipProvider><CommentCard id="c1" index={0} /></TooltipProvider></Provider>);
  const rows = document.querySelectorAll('[data-comment-id="c1"] [data-clip]');
  expect([...rows].map((r) => r.textContent)).toEqual([expect.stringContaining('first words'), expect.stringContaining('second words')]);
  expect(screen.queryByRole('button', { name: 'Delete the clip' })).toBeNull();
  fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Play' }));
  expect(FakeAudio.all[0]!.src).toBe(`/voice/${'2'.repeat(64)}`);
  expect(FakeAudio.all[0]!.paused).toBe(false);
});

it('a comment of clips only has its card too', () => {
  const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [comment({ text: '' })] })));
  render(<Provider store={store}><TooltipProvider><CommentCard id="c1" index={0} /></TooltipProvider></Provider>);
  expect(document.querySelectorAll('[data-clip]')).toHaveLength(2);
});

it('the sent comments under a user message show their clips', () => {
  const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'go', ts: 0, historic: true }));
    store.dispatch(serverEvent({ kind: 'comments', items: [comment({ status: 'sent', sentIn: 'u1' })] }));
  });
  const { container } = render(<Provider store={store}><TooltipProvider><Feed /></TooltipProvider></Provider>);
  const d = container.querySelector('[data-item-id="u1"] details')!;
  expect(d.textContent).toContain('typed note');
  expect(d.querySelectorAll('[data-clip]')).toHaveLength(2);
  expect(d.textContent).toContain('second words');
});
