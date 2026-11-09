import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CLAUDE_CAPABILITIES, type ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { resetPlayer } from '@/voice/player.ts';
import { mic } from '@/voice/recorder.ts';
import { CommentPopup, type PendingComment } from './CommentPopup.tsx';
import type { PendingSelection } from './SelectionButton.tsx';

const pending: PendingSelection = {
  anchor: { source: { kind: 'message', id: 'a1' }, start: 6, end: 17, quote: 'brave world', prefix: 'hello ', suffix: '' },
  rect: { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} } as DOMRect,
};
const wave = Array.from({ length: 48 }, (_, i) => i % 32);
const wav = new Blob([new Uint8Array(44)], { type: 'audio/wav' });

let nextId = 0;
let texts: Record<string, () => Response | Promise<Response>> = {};
let transcribeCalls: string[] = [];
/** the host's ids: n repeated to 64 characters; the text route sees the first character, so up to 9 clips tell apart */
const idOf = (n: number) => String(n).repeat(64);

beforeEach(() => {
  setLang('en');
  nextId = 0;
  texts = {};
  transcribeCalls = [];
  vi.spyOn(mic, 'start').mockImplementation(async () => ({ stop: async () => ({ wav, ms: 2000, wave }), cancel: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/voice') return Response.json({ id: idOf(++nextId % 10), ms: 2000, wave });
    const m = /^\/voice\/(\d)\d+\/text/.exec(url);
    if (m) {
      transcribeCalls.push(url);
      return (texts[m[1]!] ?? (() => Response.json({ text: `clip ${m[1]}` })))();
    }
    return new Response('', { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  resetPlayer();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup({ whisper = true, protocol = 14 } = {}) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  store.dispatch({ type: 'server/event', payload: { kind: 'hello', protocol, capabilities: { ...CLAUDE_CAPABILITIES, ...(whisper ? { dictation: 'whisper' } : {}) } } });
  const onClose = vi.fn();
  render(<Provider store={store}><TooltipProvider><CommentPopup pending={pending as PendingComment} onClose={onClose} /></TooltipProvider></Provider>);
  return { store, onClose, comments: () => store.getState().comments.items };
}
const micBtn = () => screen.getByTestId('popup-mic');
const addBtn = () => screen.getByRole('button', { name: 'Add' });
/** click the mic, then stop: one clip */
async function record() {
  fireEvent.click(micBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
}

it('a protocol 13 server gets no mic in the popup', () => {
  setup({ protocol: 13 });
  expect(screen.queryByTestId('popup-mic')).toBeNull();
});

it('without Whisper the popup mic opens Settings', () => {
  const { store } = setup({ whisper: false });
  fireEvent.click(micBtn());
  expect(store.getState().tabs.active).toBe('settings');
  expect(mic.start).not.toHaveBeenCalled();
});

it('click records, click on Stop adds a clip row that is transcribed; Add waits for the transcript', async () => {
  let release!: () => void;
  texts['1'] = () => new Promise<Response>((res) => { release = () => res(Response.json({ text: 'water the plants' })); });
  const { comments } = setup();
  await record();
  const row = await screen.findByTestId('popup-clips');
  expect(within(row).getAllByRole('button', { name: 'Play' })).toHaveLength(1);
  expect(within(row).getByText('Transcribing…')).toBeInTheDocument();
  expect(addBtn()).toBeDisabled();
  expect(transcribeCalls[0]).toBe(`/voice/${idOf(1)}/text?lang=en`);
  release();
  expect(await within(row).findByText('water the plants')).toBeInTheDocument();
  await waitFor(() => expect(addBtn()).toBeEnabled());
  fireEvent.click(addBtn());
  expect(comments()).toHaveLength(1);
  expect(comments()[0]).toMatchObject({ text: '', voice: [{ id: idOf(1), ms: 2000, wave, text: 'water the plants' }] });
});

it('several clips keep their order; delete removes one; Esc while recording drops the recording, not the popup', async () => {
  const { comments, onClose } = setup();
  await record();
  await screen.findByText('clip 1');
  await record();
  await screen.findByText('clip 2');
  fireEvent.click(within(screen.getByTestId('popup-clips')).getAllByRole('button', { name: 'Delete the clip' })[0]!);
  expect(screen.queryByText('clip 1')).toBeNull();
  await record();
  await screen.findByText('clip 3');
  // a recording in progress, Esc: only the recording goes
  fireEvent.click(micBtn());
  await screen.findByRole('button', { name: 'Stop recording' });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId('popup-clips').querySelectorAll('[data-clip]')).toHaveLength(2);
  fireEvent.click(addBtn());
  expect(comments()[0]!.voice!.map((v) => v.text)).toEqual(['clip 2', 'clip 3']);
});

it('typed text and clips go in one comment; a failed transcript blocks Add until Retry or delete', async () => {
  texts['1'] = () => new Response('', { status: 503 });
  const { comments } = setup();
  fireEvent.change(screen.getByPlaceholderText('Comment…'), { target: { value: 'see this' } });
  await record();
  expect(await screen.findByText('Whisper is off on the computer')).toBeInTheDocument();
  expect(addBtn()).toBeDisabled();
  delete texts['1'];
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('clip 1');
  await waitFor(() => expect(addBtn()).toBeEnabled());
  fireEvent.click(addBtn());
  expect(comments()[0]).toMatchObject({ text: 'see this', voice: [{ text: 'clip 1' }] });
});

it('an empty transcript shows "Nothing was recognised" and can be deleted to unblock Add', async () => {
  texts['1'] = () => Response.json({ text: '  ' });
  setup();
  await record();
  expect(await screen.findByText('Nothing was recognised')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete the clip' }));
  expect(screen.queryByTestId('popup-clips')).toBeNull();
  expect(addBtn()).toBeEnabled();
});

it('at most 10 clips: the mic goes off at the tenth', async () => {
  setup();
  for (let i = 0; i < 10; i++) {
    await record();
    await waitFor(() => expect(screen.getByTestId('popup-clips').querySelectorAll('[data-clip]')).toHaveLength(i + 1)); // the mic is off while a clip uploads
  }
  expect(micBtn()).toBeDisabled();
});
