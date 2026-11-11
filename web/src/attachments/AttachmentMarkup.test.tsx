import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, Comment, MediaShape } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { addShape, selectDraft } from '@/media/markup/slice.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { AttachmentMarkup } from './AttachmentMarkup.tsx';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('@/media/markup/createMediaComment.ts', async (orig) => ({
  ...(await orig<typeof import('@/media/markup/createMediaComment.ts')>()),
  prepareAttachmentComment: prepare,
}));

const ID = 'a'.repeat(64);
const rect: MediaShape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

beforeEach(() => {
  setLang('en');
  prepare.mockReset();
  prepare.mockResolvedValue({ images: ['c'.repeat(64)], anchor: {} });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 800 });
});
afterEach(cleanup);

function setup(items: Comment[] = []) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items })));
  const onClose = vi.fn();
  render(<Provider store={store}><TooltipProvider><AttachmentMarkup id={ID} onClose={onClose} /></TooltipProvider></Provider>);
  return { store, sent, onClose };
}

it('opens in markup mode over the attached image', () => {
  const { store } = setup();
  expect(document.querySelector(`img[src="/attach/${ID}"]`)).not.toBeNull();
  expect(selectDraft(store.getState(), `attach:${ID}`).on).toBe(true);
  expect(screen.getByRole('toolbar')).toBeInTheDocument();
});

it('Comment on a drawing and Add: an attachment comment with the composite as its image, nothing to /marks', async () => {
  const { store, sent } = setup();
  act(() => void store.dispatch(addShape(`attach:${ID}`, rect)));
  await userEvent.click(screen.getByRole('button', { name: 'Comment (Enter)' }));
  await userEvent.type(screen.getByPlaceholderText(/comment/i), 'this part');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(store.getState().comments.items).toHaveLength(1));
  const c = store.getState().comments.items[0]!;
  expect(c.anchor).toEqual({ kind: 'attachment', image: ID, width: 1200, height: 800, shapes: [rect] });
  expect(c.images).toEqual(['c'.repeat(64)]);
  expect(c.genImages).toBe(1);
  expect(c.text).toBe('this part');
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(selectDraft(store.getState(), `attach:${ID}`).shapes).toEqual([]); // the shapes went into the comment
  expect(sent.some((m) => m.type === 'comments')).toBe(true);
});

it('leaving the markup mode closes the overlay', async () => {
  const { onClose } = setup();
  await userEvent.click(screen.getByRole('button', { name: 'Leave markup (Esc)' }));
  expect(onClose).toHaveBeenCalled();
});

it('Esc with an open drawing asks before discarding; the popup keeps its own Esc', async () => {
  const { store, onClose } = setup();
  act(() => void store.dispatch(addShape(`attach:${ID}`, rect)));
  await userEvent.keyboard('{Escape}');
  expect(screen.getByText('Discard the drawing?')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

it('the marks of the image\'s existing comments are drawn dimmed', () => {
  const other: Comment = { id: 'x', text: 't', status: 'pending', createdAt: 1, images: ['d'.repeat(64)], genImages: 1, anchor: { kind: 'attachment', image: ID, width: 1200, height: 800, shapes: [rect] } };
  const elsewhere: Comment = { ...other, id: 'y', anchor: { ...other.anchor, image: 'b'.repeat(64) } as Comment['anchor'] };
  setup([other, elsewhere]);
  expect(document.querySelectorAll('[data-attach-mark]')).toHaveLength(1);
});
