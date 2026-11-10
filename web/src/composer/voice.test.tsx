import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { CLAUDE_CAPABILITIES } from '@nota-bene/shared';
import { connState, makeStore, serverEvent } from '@/store/store.ts';
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
let takeMs = 3000;

beforeEach(() => {
  setLang('en');
  fakes = [];
  uploads = [];
  uploadOk = true;
  takeMs = 3000;
  vi.spyOn(mic, 'start').mockImplementation(async (opts) => {
    const recorder = { stop: vi.fn(async () => ({ wav, ms: takeMs, wave: VOICE.wave })), cancel: vi.fn() };
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

it('without navigator.mediaDevices (an insecure page) the note says the page must be secure', async () => {
  vi.mocked(mic.start).mockRejectedValueOnce(new TypeError('undefined is not an object'));
  setup();
  fireEvent.click(micBtn());
  expect(await screen.findByText(/needs a secure page.*localhost or over https/)).toBeInTheDocument();
});

it('a denied microphone says so in the status line', async () => {
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: {} });
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

it('the 10-minute cap sends a held recording, as a release does', async () => {
  const { sent } = setup();
  fireEvent.pointerDown(micBtn(), { button: 0 });
  await waitFor(() => expect(fakes).toHaveLength(1));
  act(() => fakes[0]!.opts.onCap());
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
});

it('the 10-minute cap on a locked recording goes to the preview, as Stop does', async () => {
  const { sent } = setup();
  fireEvent.click(micBtn());
  await screen.findByTestId('record-bar');
  act(() => fakes[0]!.opts.onCap());
  await screen.findByRole('button', { name: 'Play' });
  expect(sent).toHaveLength(0);
  expect(uploads).toHaveLength(0);
});

it('an uploaded recording that cannot go out (offline) stays in the preview; Send then sends it without a second upload', async () => {
  const { sent, store } = setup();
  fireEvent.click(micBtn());
  await screen.findByTestId('record-bar');
  act(() => void store.dispatch(connState('closed')));
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(await screen.findByText(/The voice message was not sent/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  act(() => void store.dispatch(connState('open')));
  fireEvent.click(screen.getByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(uploads).toHaveLength(1);
  expect(screen.queryByTestId('record-bar')).toBeNull();
});

it('a later send-refused restores the same recording in the preview; Send re-sends it without uploading again', async () => {
  const { sent, store } = setup();
  fireEvent.click(micBtn());
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(screen.queryByTestId('record-bar')).toBeNull();
  const id = (sent[0] as { id: string }).id;
  act(() => void store.dispatch(serverEvent({ kind: 'send-refused', id, reason: 'busy' } as never)));
  expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(2));
  expect(uploads).toHaveLength(1);
  expect((sent[1] as { voice: unknown }).voice).toEqual(VOICE);
});

it('a take of 0 ms says so instead of going idle silently', async () => {
  takeMs = 0;
  setup();
  fireEvent.click(micBtn());
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  expect(await screen.findByText('Nothing was recorded')).toBeInTheDocument();
  expect(screen.queryByTestId('record-bar')).toBeNull();
});

it('a release before the microphone has opened (the permission prompt) locks the recording, it does not send a 0 ms take', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  let open!: (r: Recorder) => void;
  vi.mocked(mic.start).mockImplementationOnce((opts) => new Promise<Recorder>((res) => { open = res; void opts; }));
  const { sent } = setup();
  fireEvent.pointerDown(micBtn(), { button: 0 });
  vi.setSystemTime(Date.now() + 5000); // the user thought about the prompt
  fireEvent.pointerUp(window);
  const recorder = { stop: vi.fn(async () => ({ wav, ms: 10, wave: VOICE.wave })), cancel: vi.fn() };
  await act(async () => { open(recorder); });
  expect(recorder.stop).not.toHaveBeenCalled();
  expect(sent).toHaveLength(0);
  expect(await screen.findByRole('button', { name: /Send the voice message/ })).toBeInTheDocument();
});

it('after an unmount an upload still in flight does not send', async () => {
  let finish!: () => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { finish = () => res(Response.json(VOICE)); })));
  const { sent, view } = setup();
  fireEvent.click(micBtn());
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(finish).toBeDefined());
  view.unmount();
  await act(async () => { finish(); });
  expect(sent).toHaveLength(0);
});

it('the live wave follows the input level', async () => {
  setup();
  fireEvent.click(micBtn());
  await screen.findByTestId('record-bar');
  act(() => { fakes[0]!.opts.onLevel(0.2); fakes[0]!.opts.onLevel(0.9); });
  expect(screen.getByTestId('live-wave').querySelectorAll('[data-bar]')).toHaveLength(2);
});

// ---- a voice message while the agent works behaves like a typed one: Send queues, the forced send asks first
const busyNow = (store: ReturnType<typeof setup>['store']) => act(() => void store.dispatch({ type: 'server/event', payload: { kind: 'user', id: 'u1', text: 'x', ts: 0 } }));
const lock = async () => { fireEvent.click(micBtn()); await screen.findByTestId('record-bar'); };
const FORCED = { type: 'send', id: expect.any(String), text: '', voice: VOICE, lang: 'en', force: true };

it('busy: Send queues the voice message (no force on the wire)', async () => {
  const { sent, store } = setup();
  busyNow(store);
  await lock();
  fireEvent.click(await screen.findByRole('button', { name: /Send the voice message/ }));
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(sent[0]).toEqual({ type: 'send', id: expect.any(String), text: '', voice: VOICE, lang: 'en' });
});

it('busy: Enter queues it, Ctrl+Enter only asks and the second one forces', async () => {
  const { sent, store } = setup();
  busyNow(store);
  await lock();
  fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
  expect(await screen.findByRole('alert')).toHaveTextContent('The agent will be interrupted');
  expect(uploads).toHaveLength(0);
  expect(sent).toHaveLength(0);
  expect(screen.getByTestId('record-bar')).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(sent[0]).toEqual(FORCED);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('busy: Cmd+Enter forces too, and the confirmation button sends it', async () => {
  const { sent, store } = setup();
  busyNow(store);
  await lock();
  fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Interrupt and send' }));
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(sent[0]).toEqual(FORCED);
});

it('busy: a Ctrl-click on Send asks, then forces; Cancel in the question keeps the recording', async () => {
  const { sent, store } = setup();
  busyNow(store);
  await lock();
  const sendBtn = () => screen.getByRole('button', { name: /Send the voice message/ });
  fireEvent.click(sendBtn(), { ctrlKey: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('record-bar')).toBeInTheDocument();
  fireEvent.click(sendBtn(), { ctrlKey: true });
  await screen.findByRole('alert');
  fireEvent.click(sendBtn(), { ctrlKey: true });
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(sent[0]).toEqual(FORCED);
});

it('busy: Ctrl+Alt+R asks, the second one forces; plain Alt+R queues', async () => {
  const { sent, store, off } = setup();
  busyNow(store);
  await lock();
  fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', altKey: true, ctrlKey: true });
  await screen.findByRole('alert');
  expect(sent).toHaveLength(0);
  fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', altKey: true, ctrlKey: true });
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(sent[0]).toEqual(FORCED);
  off();
});

it('busy: plain Alt+R sends it queued', async () => {
  const { sent, store, off } = setup();
  busyNow(store);
  await lock();
  fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', altKey: true });
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(sent[0]).not.toHaveProperty('force');
  off();
});

it('idle: Ctrl+Enter has nothing to interrupt, it is a plain send', async () => {
  const { sent } = setup();
  await lock();
  fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(voiceSends(sent)).toHaveLength(1));
  expect(sent[0]).not.toHaveProperty('force');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('Esc dismisses the question first, the next Esc cancels the recording', async () => {
  const { store } = setup();
  busyNow(store);
  await lock();
  fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
  await screen.findByRole('alert');
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('record-bar')).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByTestId('record-bar')).toBeNull();
});

it('the Send tooltip names Enter, Alt+R and, while busy, the forcing keys', async () => {
  const { store } = setup();
  await lock();
  const send = screen.getByRole('button', { name: /Send the voice message/ });
  expect(send.getAttribute('title')).toMatch(/Enter/);
  expect(send.getAttribute('title')).toMatch(/Alt\+R|⌥R/);
  expect(send.getAttribute('title')).not.toMatch(/interrupt/i);
  busyNow(store);
  expect(screen.getByRole('button', { name: /Send the voice message/ }).getAttribute('title')).toMatch(/queue[\s\S]*(Ctrl\+Enter|⌘Enter)[\s\S]*interrupt/i);
});
