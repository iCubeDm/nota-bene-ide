import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CLAUDE_CAPABILITIES, PROTOCOL, type ClientMessage, type Comment } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { mic } from '@/voice/recorder.ts';
import { resetPlayer } from '@/voice/player.ts';
import { selectSendable } from '@/comments/send.ts';
import { installKeymap } from '@/shell/keymap.ts';
import { Composer } from './Composer.tsx';
import { addImage, selectDraft, selectImages, setDraft } from './slice.ts';

const VOICE = { id: 'c'.repeat(64), ms: 3000, wave: Array.from({ length: 48 }, (_, i) => i % 32) };
const wav = new Blob([new Uint8Array(44)], { type: 'audio/wav' });

beforeEach(() => {
  setLang('en');
  localStorage.clear();
  localStorage.setItem('panel:comments', '0');
  vi.spyOn(mic, 'start').mockImplementation(async () => ({ stop: async () => ({ wav, ms: 3000, wave: VOICE.wave }), cancel: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(VOICE)));
});
afterEach(() => {
  cleanup();
  resetPlayer();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cm = (id: string): Comment => ({
  id, anchor: { source: { kind: 'message', id: 'u0' }, start: 0, end: 1, quote: 'q', prefix: '', suffix: '' }, text: 'note', status: 'pending', createdAt: 1,
});

function setup({ protocol = PROTOCOL, whisper = true, comments = [] as Comment[] } = {}) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  const feed = (ev: Parameters<typeof serverEvent>[0]) => act(() => void store.dispatch(serverEvent(ev)));
  feed({ kind: 'hello', protocol, capabilities: { ...CLAUDE_CAPABILITIES, ...(whisper ? { dictation: 'whisper' } : {}) } } as never);
  feed({ kind: 'user', id: 'u0', text: 'first', ts: 0, historic: true });
  feed({ kind: 'comments', items: comments });
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  return { sent, store, feed, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}
const mic$ = () => screen.queryByTestId('mic');
const send$ = () => screen.queryByRole('button', { name: /^(Send|Run)/ });

it('an empty field shows the mic and no Send', () => {
  setup();
  expect(mic$()).toBeInTheDocument();
  expect(send$()).toBeNull();
});

it('typed text swaps the mic for Send; clearing the field brings the mic back', async () => {
  const { box } = setup();
  await userEvent.type(box, 'hi');
  expect(mic$()).toBeNull();
  expect(send$()).toBeInTheDocument();
  await userEvent.clear(box);
  expect(mic$()).toBeInTheDocument();
  expect(send$()).toBeNull();
});

it('white space alone is nothing to send: the mic stays', async () => {
  const { box } = setup();
  await userEvent.type(box, '  ');
  expect(mic$()).toBeInTheDocument();
});

it('an attached image alone shows Send', () => {
  const { store } = setup();
  act(() => void store.dispatch(addImage({ id: 'a'.repeat(64) + '.png', mediaType: 'image/png' } as never)));
  expect(mic$()).toBeNull();
  expect(send$()).toBeInTheDocument();
});

it('a `!` shell text shows Run in the Send place', async () => {
  const { box } = setup();
  await userEvent.type(box, '!ls');
  expect(mic$()).toBeNull();
  expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
});

it('Send sends the text and the mic returns', async () => {
  const { box, sent } = setup();
  await userEvent.type(box, 'hello');
  await userEvent.click(send$()!);
  expect(sent.find((m) => m.type === 'send')).toMatchObject({ text: 'hello' });
  expect(mic$()).toBeInTheDocument();
});

it('with pending comments and an empty field the mic stays; typing makes Send N', async () => {
  const { box } = setup({ comments: [cm('c1'), cm('c2')] });
  expect(mic$()).toBeInTheDocument();
  expect(send$()).toBeNull();
  await userEvent.type(box, 'x');
  expect(screen.getByRole('button', { name: 'Send (2)' })).toBeInTheDocument();
});

it('a server without voice (protocol 13) always shows Send', () => {
  setup({ protocol: 13 });
  expect(mic$()).toBeNull();
  expect(send$()).toBeInTheDocument();
});

it('the prompt history button is left of the field, the action button right of it', () => {
  const { box } = setup();
  const hist = screen.getByTestId('prompt-history');
  const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(hist, box)).toBe(true);
  expect(follows(box, mic$()!)).toBe(true);
  expect(follows(mic$()!, screen.getByRole('button', { name: 'Stop the agent' }))).toBe(true);
});

it('a recording made with pending comments takes them along (protocol 16)', async () => {
  const { sent } = setup({ comments: [cm('c1')] });
  fireEvent.click(mic$()!);
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(sent.some((m) => m.type === 'send')).toBe(true));
  const m = sent.find((x) => x.type === 'send') as Extract<ClientMessage, { type: 'send' }>;
  expect(m.voice).toMatchObject({ id: VOICE.id });
  expect(m.commentIds).toEqual(['c1']);
  expect(m.text).toContain('note');
});

it('below protocol 16 a recording goes alone and the comments stay pending', async () => {
  const { sent } = setup({ protocol: 15, comments: [cm('c1')] });
  fireEvent.click(mic$()!);
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(sent.some((m) => m.type === 'send')).toBe(true));
  expect(sent.find((x) => x.type === 'send')).toEqual({ type: 'send', id: expect.any(String), text: '', voice: VOICE, lang: 'en' });
});

it('comments that rode along with a recording are not sendable again; a refusal gives them back', async () => {
  const { sent, box, feed, store } = setup({ comments: [cm('c1')] });
  fireEvent.click(mic$()!);
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(sent.some((m) => m.type === 'send')).toBe(true));
  await userEvent.type(box, 'x');
  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument(); // no "(1)": the comment is on its way
  expect(selectSendable(store.getState())).toHaveLength(0);
  const id = (sent.find((m) => m.type === 'send') as { id: string }).id;
  feed({ kind: 'send-refused', id, reason: 'busy' } as never);
  await waitFor(() => expect(selectSendable(store.getState())).toHaveLength(1));
});

const voiceMsg = (sent: ClientMessage[]) => sent.find((m) => m.type === 'send') as Extract<ClientMessage, { type: 'send' }>;
const altR = () => fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', altKey: true });
const IMG = 'a'.repeat(64) + '.png';
const att = (id: string, image = IMG): Comment => ({
  id, anchor: { kind: 'attachment', image, width: 10, height: 10, shapes: [] }, text: 'on the image', status: 'pending', createdAt: 2,
});
const two = () => [{ ...cm('c1'), label: 'clarify' as const }, { ...cm('c2'), text: 'second note', createdAt: 3 }];

it('the text a recording takes along equals the batch of a comments-only send of the same comments', async () => {
  const alone = setup({ comments: two() });
  await userEvent.type(alone.box, '{Enter}'); // the empty field sends the comments alone
  const batch = alone.sent.find((m) => m.type === 'send') as Extract<ClientMessage, { type: 'send' }>;
  expect(batch.commentIds).toEqual(['c1', 'c2']);
  expect(batch.text).toContain('second note');
  cleanup();
  const { sent } = setup({ comments: two() });
  fireEvent.click(mic$()!);
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(sent.some((m) => m.type === 'send')).toBe(true));
  const m = voiceMsg(sent);
  expect(m.commentIds).toEqual(batch.commentIds);
  expect(m.text).toBe(batch.text); // the same composeBatch the mobile fixtures check
  expect(m.voice).toMatchObject({ id: VOICE.id });
});

it('attachment comments stay out of a recording and stay pending; the draft and the images stay too', async () => {
  const { sent, store } = setup({ comments: [cm('c1'), att('att1')] });
  act(() => void store.dispatch(addImage({ id: IMG, mediaType: 'image/png' } as never)));
  act(() => void store.dispatch(setDraft('typed words')));
  const off = installKeymap(store);
  altR(); // Send is showing (text and an image): the shortcut records
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(sent.some((m) => m.type === 'send')).toBe(true));
  off();
  const m = voiceMsg(sent);
  expect(m.commentIds).toEqual(['c1']);
  expect(m.images).toBeUndefined();
  expect(m.text).not.toContain('typed words');
  expect(m.text).not.toContain('on the image');
  expect(store.getState().comments.items.find((c) => c.id === 'att1')?.status).toBe('pending');
  expect(selectSendable(store.getState()).map((c) => c.id)).toEqual(['att1']);
  expect(selectDraft(store.getState())).toBe('typed words');
  expect(selectImages(store.getState())).toEqual([{ id: IMG, mediaType: 'image/png' }]);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('typed words');
});

it('a detached attachment comment (its image is not in the composer) stays pending; a recording goes alone', async () => {
  const { sent, store } = setup({ comments: [att('att1')] });
  fireEvent.click(mic$()!);
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(sent.some((m) => m.type === 'send')).toBe(true));
  expect(voiceMsg(sent)).toEqual({ type: 'send', id: expect.any(String), text: '', voice: VOICE, lang: 'en' });
  expect(store.getState().comments.items[0]?.status).toBe('pending');
});

it('a draft typed, then Alt+R: the pending comments ride along and the draft stays', async () => {
  const { sent, store, box } = setup({ comments: [cm('c1')] });
  await userEvent.type(box, 'half a thought');
  const off = installKeymap(store);
  altR();
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(sent.some((m) => m.type === 'send')).toBe(true));
  off();
  const m = voiceMsg(sent);
  expect(m.commentIds).toEqual(['c1']);
  expect(m.text).not.toContain('half a thought');
  expect(selectDraft(store.getState())).toBe('half a thought');
});

// a double click on Send must not hit the mic that replaces it under the cursor
it('a press on the mic right after Send swapped to it starts nothing; after the window it records', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { box } = setup();
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(send$()!);
    expect(mic$()).toBeInTheDocument();
    fireEvent.pointerDown(mic$()!, { button: 0 }); // the second press of the double click
    fireEvent.pointerUp(window);
    expect(screen.queryByTestId('record-bar')).toBeNull();
    expect(mic.start).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 500);
    fireEvent.pointerDown(mic$()!, { button: 0 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(screen.getByTestId('record-bar')).toBeInTheDocument());
  } finally {
    vi.useRealTimers();
  }
});

it('when Send unmounts (a send that finished later) the caret stays in the field', async () => {
  const { store } = setup();
  act(() => void store.dispatch(setDraft('hi')));
  const btn = send$()!;
  btn.focus();
  expect(btn).toHaveFocus();
  act(() => void store.dispatch(setDraft('')));
  expect(screen.getByRole('textbox')).toHaveFocus();
});
