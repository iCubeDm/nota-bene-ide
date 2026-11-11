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
import { Composer } from './Composer.tsx';
import { addImage, setDraft } from './slice.ts';

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
  const { sent, store } = setup({ comments: [cm('c1')] });
  act(() => void store.dispatch(setDraft('')));
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
