import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { textOf } from '@/core/anchors/text.ts';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { Composer } from '@/plugins/composer/Composer.tsx';
import { Feed } from '@/plugins/feed/Feed.tsx';
import { setLang } from '@/core/i18n/index.ts';
import { serverEvent } from '@/core/store/store.ts';
import { makeStore } from '@/core/testing';
import { Attachments } from './Attachments.tsx';

const uploads = vi.hoisted(() => [] as Blob[]);
vi.mock('@/core/lib/image.ts', async (orig) => ({
  ...(await orig<typeof import('@/core/lib/image.ts')>()),
  prepareImage: async (f: File) => f,
  uploadImage: async (b: Blob) => (uploads.push(b), { id: (b as File).name.padEnd(64, '0'), mediaType: 'image/png' }),
}));

const files = vi.hoisted(() => [] as File[]);
vi.mock('./file.ts', async (orig) => ({
  ...(await orig<typeof import('./file.ts')>()),
  uploadFile: async (f: File) => (files.push(f), `attachments/${f.name}`),
}));

const localPage = vi.hoisted(() => ({ on: true }));
vi.mock('@/core/net/local.ts', () => ({ isLocalPage: () => localPage.on }));

const A = 'a'.padEnd(64, '0'), B = 'b'.padEnd(64, '0');
beforeEach(() => {
  setLang('en');
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  uploads.length = 0;
  files.length = 0;
  localPage.on = true;
});
afterEach(cleanup);

function setup() {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  render(<Provider store={store}><TooltipProvider><Feed /><Composer /></TooltipProvider></Provider>);
  return { sent, store, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}
const png = (name: string) => new File(['x'], name, { type: 'image/png' });
const paste = (el: HTMLElement, files: File[]) => {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files, items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => new File([f], f.name, { type: f.type }) })) } });
  act(() => void el.dispatchEvent(ev));
  return ev;
};

it('pasting a pdf uploads it into attachments/ and puts its path at the caret (issue 461)', async () => {
  const { box } = setup();
  await userEvent.type(box, 'see  now');
  box.setSelectionRange(4, 4);
  paste(box, [new File(['x'], 'a b.pdf', { type: 'application/pdf' })]);
  await waitFor(() => expect(box.value).toBe('see `attachments/a b.pdf` now'));
  expect(files.map((f) => f.name)).toEqual(['a b.pdf']);
  expect(document.querySelectorAll('img')).toHaveLength(0);
  expect(screen.queryByText(/Only images/)).toBeNull();
});

it('a sound or a video goes in as an embed, so it plays in the feed; a failed upload says so and inserts nothing', async () => {
  const { box } = setup();
  paste(box, [new File(['x'], 'take.mp3', { type: 'audio/mpeg' })]);
  await waitFor(() => expect(box.value).toBe('![](attachments/take.mp3)'));
  const mod = await import('./file.ts');
  vi.spyOn(mod, 'uploadFile').mockRejectedValueOnce(new Error('x'));
  paste(box, [new File(['x'], 'b.zip', { type: 'application/zip' })]);
  expect(await screen.findByText('Could not upload b.zip')).toBeInTheDocument();
  expect(box.value).toBe('![](attachments/take.mp3)');
});

it('Send waits while a file uploads', async () => {
  const mod = await import('./file.ts');
  let done!: (p: string) => void;
  vi.spyOn(mod, 'uploadFile').mockReturnValueOnce(new Promise((r) => (done = r)));
  const { box } = setup();
  paste(box, [new File(['x'], 'b.zip', { type: 'application/zip' })]);
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(document.querySelector('[data-pending-file]')).toHaveTextContent('b.zip');
  await act(async () => done('attachments/b.zip'));
  expect(box.value).toBe('`attachments/b.zip`');
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
});

it('the × on an uploading file cancels it: nothing is inserted and nothing is said', async () => {
  const mod = await import('./file.ts');
  let seen: AbortSignal | undefined;
  vi.spyOn(mod, 'uploadFile').mockImplementationOnce((_f, signal) => new Promise((_r, reject) => {
    seen = signal;
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const { box } = setup();
  paste(box, [new File(['x'], 'big.mov', { type: 'video/quicktime' })]);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel the upload of big.mov' }));
  expect(seen?.aborted).toBe(true);
  await waitFor(() => expect(document.querySelector('[data-pending-file]')).toBeNull());
  expect(box.value).toBe('');
  expect(screen.queryByText(/Could not upload/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled(); // nothing to send, and not stuck uploading
});

it('refusals say why: a file named attachments, too large, too large for the relay', async () => {
  const mod = await import('./file.ts');
  const { box } = setup();
  vi.spyOn(mod, 'uploadFile').mockRejectedValueOnce(new mod.UploadError(409, 'attachments-not-folder'));
  paste(box, [new File(['x'], 'a.zip', { type: 'application/zip' })]);
  expect(await screen.findByText(/a file named attachments/)).toBeInTheDocument();
  vi.spyOn(mod, 'uploadFile').mockRejectedValueOnce(new mod.UploadError(413, 'file too large'));
  paste(box, [new File(['x'], 'b.zip', { type: 'application/zip' })]);
  expect(await screen.findByText('b.zip is too large (up to 8 GB)')).toBeInTheDocument();
  // a page on another computer reaches this one through the relay, which takes 32 MB at most: said before sending
  localPage.on = false;
  const big = new File(['x'], 'c.zip', { type: 'application/zip' });
  Object.defineProperty(big, 'size', { value: 33 * 1024 * 1024 });
  const before = files.length;
  paste(box, [big]);
  expect(await screen.findByText('c.zip is too large to send through the relay (up to 32 MB)')).toBeInTheDocument();
  expect(files.length).toBe(before);
});

it('files dragged from the tree drop onto the composer as their paths (issue 461)', async () => {
  const { box } = setup();
  const { PATHS_MIME } = await import('@/core/lib/drag.ts');
  const data: Record<string, string> = { [PATHS_MIME]: JSON.stringify(['docs/a.md', 'clips/take.mp4']), 'text/plain': 'docs/a.md' };
  const dataTransfer = { types: Object.keys(data), getData: (k: string) => data[k] ?? '', dropEffect: 'none', files: [] };
  const over = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(over, 'dataTransfer', { value: dataTransfer });
  act(() => void box.dispatchEvent(over));
  expect(over.defaultPrevented).toBe(true);
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
  act(() => void box.dispatchEvent(drop));
  expect(drop.defaultPrevented).toBe(true);
  expect(box.value).toBe('`docs/a.md` ![](clips/take.mp4)');
});

it('a pasted image uploads, shows a thumbnail, and sends alone with a label', async () => {
  const { sent, box } = setup();
  const ev = paste(box, [png(A)]);
  expect(ev.defaultPrevented).toBe(true);
  await waitFor(() => expect(document.querySelector('img:not([data-pending])')).toBeTruthy());
  expect(uploads).toHaveLength(1); // Chrome lists the file in files and items: one upload
  expect(document.querySelector(`img[src="/attach/${A}"]`)).toBeTruthy();
  await userEvent.type(box, '{Enter}');
  expect(sent[0]).toMatchObject({ type: 'send', text: '', images: [{ id: A, mediaType: 'image/png', label: '[image 1]' }] });
  expect(document.querySelectorAll('[data-testid="composer-thumbs"] img')).toHaveLength(0); // cleared with the draft
});

it('a failed upload shows imgFail and drops the image', async () => {
  const { box } = setup();
  const mod = await import('@/core/lib/image.ts');
  vi.spyOn(mod, 'uploadImage').mockRejectedValueOnce(new Error('x'));
  paste(box, [png(A)]);
  expect(await screen.findByText('Could not read the image')).toBeInTheDocument();
  expect(document.querySelectorAll('img')).toHaveLength(0);
});

it('the bubble renders its thumbnails outside the anchor text; a click opens the lightbox, Esc closes it without interrupting', async () => {
  const { sent, store } = setup();
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'look', ts: 0, images: [
    { id: A, mediaType: 'image/png', label: '[image 1]' }, { id: B, mediaType: 'image/png', label: '[image 2]' }] })));
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u3', text: 'look', ts: 0 })));
  const bubble = document.querySelector('[data-item-id="u1"]') as HTMLElement;
  expect(bubble.querySelectorAll('img')).toHaveLength(2);
  expect(bubble.querySelector('img')!.closest('[data-anchor-skip]')).toBeTruthy();
  expect(textOf(bubble)).toBe(textOf(document.querySelector('[data-item-id="u3"]')!)); // thumbnails add nothing to the anchor text
  await userEvent.click(bubble.querySelector('img')!);
  const lb = screen.getByRole('dialog');
  expect(lb).toHaveAttribute('data-anchor-skip');
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(sent.find((m) => m.type === 'interrupt')).toBeUndefined();
});

it('Attachments removes by id', async () => {
  const onRemove = vi.fn();
  render(<Attachments ids={[A]} onRemove={onRemove} />);
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(onRemove).toHaveBeenCalledWith(A);
});

it('Send is disabled while an upload is pending and Enter sends nothing', async () => {
  const mod = await import('@/core/lib/image.ts');
  let done!: (v: { id: string; mediaType: 'image/png' }) => void;
  vi.spyOn(mod, 'uploadImage').mockReturnValueOnce(new Promise((r) => (done = r)));
  const { sent, box } = setup();
  paste(box, [png(A)]);
  const btn = screen.getByRole('button', { name: 'Send' });
  expect(btn).toBeDisabled();
  expect(btn.parentElement).toHaveAttribute('title', 'Wait for the upload to finish');
  await userEvent.type(box, 'x{Enter}');
  expect(sent).toHaveLength(0);
  await act(async () => done({ id: A, mediaType: 'image/png' }));
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
});
