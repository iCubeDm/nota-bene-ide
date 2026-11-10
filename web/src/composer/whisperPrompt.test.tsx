import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CLAUDE_CAPABILITIES, type ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { mic } from '@/voice/recorder.ts';
import { installKeymap } from '@/shell/keymap.ts';
import { Composer } from './Composer.tsx';

type Dict = { on: boolean; phase: string; downloadMb: number; diskMb: number; dir: string; model: string };
let dict: Dict;
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  setLang('en');
  posts = [];
  dict = { on: false, phase: 'none', downloadMb: 430, diskMb: 770, dir: '/srv/nb/whisper', model: 'whisper-small' };
  vi.spyOn(mic, 'start').mockResolvedValue({ stop: vi.fn(), cancel: vi.fn() } as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === '/dictation/install') dict = { ...dict, phase: 'installing' };
      if (url === '/dictation/on') dict = { ...dict, on: true };
      return Response.json({ ok: true });
    }
    if (url === '/dictation') return Response.json(dict);
    return new Response('[]');
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(dictation?: 'whisper') {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  store.dispatch({ type: 'server/event', payload: { kind: 'hello', protocol: 14, capabilities: { ...CLAUDE_CAPABILITIES, ...(dictation ? { dictation } : {}) } } });
  const off = installKeymap(store);
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  return { store, off };
}
const prompt = () => screen.findByRole('dialog', { name: 'Voice messages need Whisper' });
const dictation = (store: ReturnType<typeof setup>['store']) => store.getState().controls.capabilities?.dictation;

it('without Whisper the mic opens a prompt with the sizes and an Install button, and records nothing', async () => {
  const { store } = setup();
  fireEvent.click(screen.getByTestId('mic'));
  const box = await prompt();
  expect(box).toHaveTextContent('≈ 430 MB');
  expect(box).toHaveTextContent('770 MB');
  expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
  expect(store.getState().tabs.active).not.toBe('settings');
  expect(mic.start).not.toHaveBeenCalled();
});

it('Install starts the settings install, shows progress, then turns Whisper on and closes', async () => {
  const { store } = setup();
  fireEvent.click(screen.getByTestId('mic'));
  await prompt();
  fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
  await waitFor(() => expect(posts.map((p) => p.url)).toEqual(['/dictation/install']));
  expect(await screen.findByText('Installing Whisper…')).toBeInTheDocument();
  expect(dictation(store)).toBeUndefined();
  dict = { ...dict, phase: 'ready' };
  await waitFor(() => expect(posts.find((p) => p.url === '/dictation/on')?.body).toEqual({ on: true }), { timeout: 4000 });
  await waitFor(() => expect(dictation(store)).toBe('whisper'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}, 8000);

it('a failed install says so and Retry installs again', async () => {
  setup();
  fireEvent.click(screen.getByTestId('mic'));
  await prompt();
  dict = { ...dict, phase: 'failed' };
  fireEvent.click(screen.getByTestId('mic')); // close
  fireEvent.click(screen.getByTestId('mic')); // reopen: reads the failed phase
  expect(await screen.findByText(/Whisper install failed/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(posts.filter((p) => p.url === '/dictation/install')).toHaveLength(1));
});

it('installed but off: the prompt offers Turn on, which switches it on', async () => {
  dict = { ...dict, phase: 'ready', on: false };
  const { store } = setup();
  fireEvent.click(screen.getByTestId('mic'));
  expect(await screen.findByText('Whisper is installed but turned off.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
  await waitFor(() => expect(posts.find((p) => p.url === '/dictation/on')?.body).toEqual({ on: true }));
  await waitFor(() => expect(dictation(store)).toBe('whisper'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('Open settings goes to Settings → Dictation and closes the prompt', async () => {
  const { store } = setup();
  fireEvent.click(screen.getByTestId('mic'));
  await prompt();
  // the Settings tab is not rendered here: its section stands in, so the scroll lookup ends inside the test
  const section = document.createElement('div');
  section.id = 'settings-dictation';
  const scrolled = vi.fn();
  section.scrollIntoView = scrolled;
  document.body.append(section);
  fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  expect(store.getState().tabs.active).toBe('settings');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(scrolled).toHaveBeenCalled());
  section.remove();
});

it('Esc closes the prompt', async () => {
  setup();
  fireEvent.click(screen.getByTestId('mic'));
  await prompt();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('Alt+R without Whisper opens the prompt too', async () => {
  const { off } = setup();
  act(() => void fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', altKey: true }));
  await prompt();
  off();
});

it('with Whisper on the mic records and shows no prompt', async () => {
  setup('whisper');
  fireEvent.click(screen.getByTestId('mic'));
  await waitFor(() => expect(mic.start).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).toBeNull();
});
