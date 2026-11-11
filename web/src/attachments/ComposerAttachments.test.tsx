import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CLAUDE_CAPABILITIES, type ClientMessage, type Comment } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { addImage, selectImages, selectMarking } from '@/composer/slice.ts';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { ComposerAttachments } from './ComposerAttachments.tsx';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
beforeEach(() => setLang('en'));
afterEach(cleanup);

const onA = (id: string, image = A): Comment => ({
  id, text: id, status: 'pending', createdAt: 1, images: ['c'.repeat(64)], genImages: 1,
  anchor: { kind: 'attachment', image, width: 10, height: 10, shapes: [{ kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 0.5, h: 0.5 }] },
});

function setup({ protocol = 17, items = [] as Comment[] } = {}) {
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (_m: ClientMessage) => true, close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'hello', protocol, capabilities: CLAUDE_CAPABILITIES }));
    store.dispatch(serverEvent({ kind: 'comments', items }));
    store.dispatch(addImage({ id: A, mediaType: 'image/png' }));
    store.dispatch(addImage({ id: B, mediaType: 'image/png' }));
  });
  render(<Provider store={store}><TooltipProvider><ComposerAttachments pending={[]} /></TooltipProvider></Provider>);
  return store;
}

it('each image has a mark button with its comment count, from protocol 17', () => {
  setup({ items: [onA('c1'), onA('c2'), onA('c3', B)] });
  const pens = screen.getAllByRole('button', { name: /Mark up and comment on the image/ });
  expect(pens).toHaveLength(2);
  expect(pens[0]).toHaveAccessibleName('Mark up and comment on the image (2 comments)');
  expect(pens[0]).toHaveTextContent('2');
  expect(pens[1]).toHaveTextContent('1');
});

it('no mark button on an older server', () => {
  setup({ protocol: 16 });
  expect(screen.queryByRole('button', { name: /Mark up/ })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
});

it('the mark button opens the overlay for its image', async () => {
  const store = setup();
  await userEvent.click(screen.getAllByRole('button', { name: /Mark up and comment/ })[1]!);
  expect(selectMarking(store.getState())).toBe(B);
  expect(document.querySelector(`[role=dialog][aria-label="Mark up and comment on the image"] img[src="/attach/${B}"]`)).not.toBeNull();
});

it('× on an image without comments removes it at once', async () => {
  const store = setup({ items: [onA('c1')] });
  await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
  expect(selectImages(store.getState()).map((i) => i.id)).toEqual([A]);
});

it('× on an image with pending comments asks; Remove drops the image and its comments, Cancel keeps both', async () => {
  const store = setup({ items: [onA('c1'), onA('c2'), onA('c3', B)] });
  await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
  expect(screen.getByText('Remove the image?')).toBeInTheDocument();
  expect(screen.getByText('2 comments on this image will be removed with it.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(selectImages(store.getState())).toHaveLength(2);
  expect(store.getState().comments.items).toHaveLength(3);
  await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(selectImages(store.getState()).map((i) => i.id)).toEqual([B]);
  expect(store.getState().comments.items.map((c) => c.id)).toEqual(['c3']);
});

it('the overlay closes when its image leaves the composer', async () => {
  const store = setup();
  await userEvent.click(screen.getAllByRole('button', { name: /Mark up and comment/ })[0]!);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  vi.useRealTimers();
  const { removeImage } = await import('@/composer/slice.ts');
  act(() => void store.dispatch(removeImage(A)));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(selectMarking(store.getState())).toBeNull();
});
