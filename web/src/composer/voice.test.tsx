import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { CLAUDE_CAPABILITIES } from '@nota-bene/shared';
import { makeStore } from '@/store/store.ts';
import { mic, type Recorder, type RecorderOptions } from '@/voice/recorder.ts';
import { resetPlayer } from '@/voice/player.ts';
import { installKeymap } from '@/shell/keymap.ts';
import { Composer } from './Composer.tsx';
import { setDraft } from './slice.ts';

const VOICE = { id: 'c'.repeat(64), ms: 3000, wave: Array.from({ length: 48 }, (_, i) => i % 32) };
const wav = new Blob([new Uint8Array(44)], { type: 'audio/wav' });

type Fake = { opts: RecorderOptions; recorder: Recorder & { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } };
let fakes: Fake[] = [];
let uploads: { url: string; init: RequestInit }[] = [];
let uploadOk = true;

beforeEach(() => {
  setLang('en');
  fakes = [];
  uploads = [];
  uploadOk = true;
  vi.spyOn(mic, 'start').mockImplementation(async (opts) => {
    const recorder = { stop: vi.fn(async () => ({ wav, ms: 3000, wave: VOICE.wave })), cancel: vi.fn() };
    fakes.push({ opts, recorder });
    return recorder;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    uploads.push({ url, init });
    return uploadOk ? Response.json(VOICE) : new Response('no', { status: 500 });
  }));
});
afterEach(() => {
  cleanup();
  resetPlayer();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup({ protocol = 14, whisper = true }: { protocol?: number; whisper?: boolean } = {}) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  store.dispatch({ type: 'server/event', payload: { kind: 'hello', protocol, capabilities: { ...CLAUDE_CAPABILITIES, ...(whisper ? { dictation: 'whisper' } : {}) } } });
  const off = installKeymap(store);
  const view = render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  return { sent, store, view, off };
}
const micBtn = () => screen.getByTestId('mic');
const voiceSends = (sent: ClientMessage[]) => sent.filter((m) => m.type === 'send');

it('a protocol 13 server gets no mic', () => {
  setup({ protocol: 13 });
  expect(screen.queryByTestId('mic')).toBeNull();
});

it('without Whisper the mic opens Settings and records nothing', () => {
  const { store } = setup({ whisper: false });
  fireEvent.click(micBtn());
  expect(store.getState().tabs.active).toBe('settings');
  expect(mic.start).not.toHaveBeenCalled();
});

it('the mic names Alt+R in its tooltip', async () => {
  setup();
  await userEvent.hover(micBtn());
  expect((await screen.findAllByText(/Voice message \((Alt\+R|⌥R)\)/)).length).toBeGreaterThan(0);
});

it('a click starts a locked recording; Send uploads the WAV and sends only the voice', async () => {
  const { sent, store } = setup();
  act(() => void store.dispatch(setDraft('half a thought')));
  fireEvent.pointerDown(micBtn(), { button: 0 });
  fireEvent.pointerUp(window);
  await waitFor(() => expect(screen.getByTestId('record-bar')).toBeInTheDocument());
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(uploads[0]).toMatchObject({ url: '/voice', init: { method: 'POST' } });
  expect(new Headers(uploads[0]!.init.headers).get('content-type')).toBe('audio/wav');
  expect(sent[0]).toEqual({ type: 'send', id: expect.any(String), text: '', voice: VOICE, lang: 'en' });
  // the draft stays
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('half a thought');
  expect(fakes[0]!.recorder.stop).toHaveBeenCalled();
});

it('Esc cancels: nothing is uploaded or sent, the microphone is released', async () => {
  const { sent } = setup();
  fireEvent.click(micBtn()); // detail 0: the keyboard's click
  await screen.findByTestId('record-bar');
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByTestId('record-bar')).toBeNull();
  expect(fakes[0]!.recorder.cancel).toHaveBeenCalled();
  expect(uploads).toHaveLength(0);
  expect(sent).toHaveLength(0);
  expect(screen.getByRole('textbox')).toBeInTheDocument();
});

it('Stop goes to the preview, Send there uploads; Enter sends too', async () => {
  const { sent } = setup();
  fireEvent.click(micBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Stop and listen' }));
  await screen.findByRole('button', { name: 'Play' });
  expect(uploads).toHaveLength(0);
  fireEvent.keyDown(document.body, { key: 'Enter' });
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(uploads).toHaveLength(1);
});

it('delete in the preview drops it', async () => {
  const { sent } = setup();
  fireEvent.click(micBtn());
  fireEvent.click(await screen.findByRole('button', { name: 'Stop and listen' }));
  await screen.findByRole('button', { name: 'Play' });
  fireEvent.click(screen.getByRole('button', { name: /Cancel the recording/ }));
  expect(screen.queryByTestId('record-bar')).toBeNull();
  expect(uploads).toHaveLength(0);
  expect(sent).toHaveLength(0);
});

it('press and hold records while held and sends on release', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const { sent } = setup();
  fireEvent.pointerDown(micBtn(), { button: 0 });
  await waitFor(() => expect(fakes).toHaveLength(1));
  vi.setSystemTime(Date.now() + 600);
  fireEvent.pointerUp(window);
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(sent[0]).toMatchObject({ voice: VOICE, text: '' });
});

it('a short press locks the recording instead of sending', async () => {
  const { sent } = setup();
  fireEvent.pointerDown(micBtn(), { button: 0 });
  await waitFor(() => expect(fakes).toHaveLength(1));
  fireEvent.pointerUp(window);
  await screen.findByRole('button', { name: /Send the voice message/ });
  expect(sent).toHaveLength(0);
});

it('Alt+R starts a recording and a second Alt+R sends it', async () => {
  const { sent, off } = setup();
  fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', altKey: true });
  await screen.findByTestId('record-bar');
  fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', altKey: true });
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  off();
});

it('a denied microphone says so in the status line', async () => {
  vi.mocked(mic.start).mockRejectedValueOnce(new Error('denied'));
  setup();
  fireEvent.click(micBtn());
  expect(await screen.findByText('The microphone is not available: allow it for this page')).toBeInTheDocument();
  expect(screen.queryByTestId('record-bar')).toBeNull();
  expect(screen.getByRole('textbox')).toBeInTheDocument();
});

it('a failed upload keeps the recording in the preview with a note; Send tries again', async () => {
  const { sent } = setup();
  uploadOk = false;
  fireEvent.click(micBtn());
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  expect(await screen.findByText('Could not send the recording to the computer')).toBeInTheDocument();
  expect(sent).toHaveLength(0);
  uploadOk = true;
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
});

it('the 10-minute cap sends the recording as a release does', async () => {
  const { sent } = setup();
  fireEvent.click(micBtn());
  await screen.findByTestId('record-bar');
  act(() => fakes[0]!.opts.onCap());
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
});

it('the live wave follows the input level', async () => {
  setup();
  fireEvent.click(micBtn());
  await screen.findByTestId('record-bar');
  act(() => { fakes[0]!.opts.onLevel(0.2); fakes[0]!.opts.onLevel(0.9); });
  expect(screen.getByTestId('live-wave').querySelectorAll('[data-bar]')).toHaveLength(2);
});
