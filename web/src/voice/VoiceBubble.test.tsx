import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { getToasts, resetToasts } from '@/shell/toast.ts';
import { resetPlayer } from './player.ts';

class FakeAudio {
  static all: FakeAudio[] = [];
  paused = true; ended = false; currentTime = 0; preload = '';
  src: string;
  private ls = new Map<string, (() => void)[]>();
  constructor(src: string) { this.src = src; FakeAudio.all.push(this); }
  addEventListener(ev: string, fn: () => void) { this.ls.set(ev, [...(this.ls.get(ev) ?? []), fn]); }
  emit(ev: string) { for (const fn of this.ls.get(ev) ?? []) fn(); }
  play() { this.paused = false; this.emit('play'); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
}

beforeEach(() => {
  setLang('en');
  FakeAudio.all = [];
  vi.stubGlobal('Audio', FakeAudio);
  resetToasts();
});
afterEach(() => {
  cleanup();
  resetPlayer();
  vi.unstubAllGlobals();
});

const V1 = 'a'.repeat(64), V2 = 'b'.repeat(64);
const voice = (id: string, ms = 12_000) => ({ id, ms, wave: Array.from({ length: 48 }, (_, i) => (i * 5) % 32) });

function setup() {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  render(<Provider store={store}><Feed /></Provider>);
  const ev = (e: ServerEvent) => act(() => void store.dispatch(serverEvent(e)));
  return { sent, store, ev };
}
const userV = (id: string, v = V1, extra: object = {}): ServerEvent => ({ kind: 'user', id, text: '', ts: Date.now(), voice: voice(v), ...extra });

it('a voice message shows the player, the length and Transcribing… until the transcript comes', () => {
  const { ev } = setup();
  ev(userV('m1'));
  expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  expect(screen.getAllByTestId('wave')[0]!.querySelectorAll('[data-bar]')).toHaveLength(48);
  expect(screen.getByTestId('voice-time')).toHaveTextContent('0:12');
  expect(screen.getByText('Transcribing…')).toBeInTheDocument();
  ev({ kind: 'voice-text', id: 'm1', text: 'water the plants', ts: 1 });
  expect(screen.queryByText('Transcribing…')).toBeNull();
  expect(screen.getByText('water the plants')).toBeInTheDocument();
});

it('the Aa button folds the transcript and opens it again', () => {
  const { ev } = setup();
  ev(userV('m1'));
  ev({ kind: 'voice-text', id: 'm1', text: 'water the plants', ts: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Show or hide the text' }));
  expect(screen.queryByText('water the plants')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show or hide the text' }));
  expect(screen.getByText('water the plants')).toBeInTheDocument();
});

it('a replayed voice message shows its transcript at once', () => {
  const { ev } = setup();
  ev({ kind: 'replay', events: [userV('m1', V1, { text: 'from the past', historic: true, ts: 0 })] });
  expect(screen.getByText('from the past')).toBeInTheDocument();
  expect(screen.queryByText('Transcribing…')).toBeNull();
});

it('an error shows its text; Retry sends the same voice as a new message and hides the failed bubble', () => {
  const { ev, sent } = setup();
  ev(userV('m1'));
  ev({ kind: 'voice-text', id: 'm1', error: 'empty', ts: 1 });
  expect(screen.getByText('Nothing was recognised')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(sent).toHaveLength(1);
  const m = sent[0] as Extract<ClientMessage, { type: 'send' }>;
  expect(m).toMatchObject({ type: 'send', text: '', lang: 'en', voice: voice(V1) });
  expect(m.id).not.toBe('m1');
  expect(m.force).toBeUndefined();
  expect(m.commentIds).toBeUndefined();
  expect(m.images).toBeUndefined();
  // the host echoes the new message: the failed one is gone, the new one shows
  ev(userV(m.id));
  expect(document.querySelectorAll('[data-kind="user"]')).toHaveLength(1);
  expect(document.querySelector('[data-kind="user"]')).toHaveAttribute('data-item-id', m.id);
  expect(screen.queryByText('Nothing was recognised')).toBeNull();
});

it('each error has its own text', () => {
  const { ev } = setup();
  ev(userV('m1'));
  ev({ kind: 'voice-text', id: 'm1', error: 'off', ts: 1 });
  expect(screen.getByText('Whisper is off on the computer')).toBeInTheDocument();
  ev(userV('m2', V2));
  ev({ kind: 'voice-text', id: 'm2', error: 'failed', ts: 1 });
  expect(screen.getByText('Could not transcribe')).toBeInTheDocument();
});

it('a refused voice send is told, not lost silently', () => {
  const { ev, sent } = setup();
  ev(userV('m1'));
  ev({ kind: 'voice-text', id: 'm1', error: 'failed', ts: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  ev({ kind: 'send-refused', id: (sent[0] as { id: string }).id, reason: 'busy' });
  expect(getToasts().some((x) => x.title.includes('The voice message was not sent'))).toBe(true);
});

it('Retry mid-switch says "switching", not "offline"', () => {
  const { ev, store, sent } = setup();
  ev(userV('m1'));
  ev({ kind: 'voice-text', id: 'm1', error: 'failed', ts: 1 });
  act(() => void store.dispatch({ type: 'controls/switchStarted' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(sent).toHaveLength(0);
  expect(getToasts().map((x) => x.title)).toEqual(['switching…']);
});

it('play toggles the recording from /voice/<id>; starting a second one stops the first', () => {
  const { ev } = setup();
  ev(userV('m1', V1));
  ev(userV('m2', V2));
  const [p1, p2] = screen.getAllByRole('button', { name: 'Play' });
  fireEvent.click(p1!);
  expect(FakeAudio.all[0]!.src).toBe(`/voice/${V1}`);
  expect(FakeAudio.all[0]!.paused).toBe(false);
  expect(screen.getAllByRole('button', { name: 'Pause' })).toHaveLength(1);
  fireEvent.click(p2!);
  expect(FakeAudio.all[0]!.paused).toBe(true);
  expect(FakeAudio.all[1]!.paused).toBe(false);
  expect(screen.getAllByRole('button', { name: 'Pause' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  expect(FakeAudio.all[1]!.paused).toBe(true);
});

it('the position shows while playing and a click on the wave seeks', () => {
  const { ev } = setup();
  ev(userV('m1'));
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  const a = FakeAudio.all[0]!;
  a.currentTime = 3.2;
  act(() => a.emit('timeupdate'));
  expect(screen.getByTestId('voice-time')).toHaveTextContent('0:03');
  const wave = screen.getAllByTestId('wave')[0]!;
  wave.getBoundingClientRect = () => ({ left: 100, width: 100, right: 200, top: 0, bottom: 0, height: 0, x: 100, y: 0, toJSON() {} });
  fireEvent.pointerDown(wave, { clientX: 150 });
  expect(a.currentTime).toBeCloseTo(6);
});
