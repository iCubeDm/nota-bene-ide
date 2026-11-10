import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { RecordBar } from './RecordBar.tsx';
import type { RecState } from './useVoiceRecorder.ts';

afterEach(cleanup);
setLang('en');
const live: RecState = { phase: 'recording', held: false, ms: 1000, levels: [] };
const preview: RecState = { phase: 'preview', recording: { wav: new Blob([]), ms: 3000, wave: Array(48).fill(3) }, url: '' };
const bar = (state: Exclude<RecState, { phase: 'idle' }>, onCancel = vi.fn(), onSend = vi.fn(), extra: object = {}) => (
  <TooltipProvider><RecordBar state={state} onCancel={onCancel} onSend={onSend} {...extra} /></TooltipProvider>
);
const esc = (target: Element = document.body, init: KeyboardEventInit = {}) => fireEvent.keyDown(target, { key: 'Escape', ...init });

it('an Esc that another layer already took (a closed menu) does not cancel the recording', () => {
  const onCancel = vi.fn();
  const stop = (e: Event) => e.preventDefault();
  document.addEventListener('keydown', stop, true); // a popup's handler that ran first
  render(bar(live, onCancel));
  esc();
  document.removeEventListener('keydown', stop, true);
  expect(onCancel).not.toHaveBeenCalled();
});

it('an Esc from a control elsewhere on the page does not cancel the recording', () => {
  const onCancel = vi.fn();
  render(<div><button data-testid="elsewhere">x</button>{bar(live, onCancel)}</div>);
  esc(screen.getByTestId('elsewhere'));
  expect(onCancel).not.toHaveBeenCalled();
  esc(); // no focus at all: the bar takes it
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it('a stopped preview is deleted by Esc only with focus in the bar', () => {
  const onCancel = vi.fn();
  render(bar(preview, onCancel));
  esc();
  expect(onCancel).not.toHaveBeenCalled();
  esc(screen.getByRole('button', { name: 'Play' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it('two bars: one Esc cancels only the newest', () => {
  const a = vi.fn(), b = vi.fn();
  render(<div>{bar(live, a)}</div>);
  render(<div>{bar(live, b)}</div>);
  esc();
  expect(b).toHaveBeenCalledTimes(1);
  expect(a).not.toHaveBeenCalled();
});

it('inside its scope (the comment popup) the older bar takes the Esc, and the newer one elsewhere does not', () => {
  const popup = vi.fn(), composer = vi.fn();
  render(<div data-record-scope><input data-testid="in" />{bar(live, popup)}</div>);
  render(<div>{bar(live, composer)}</div>);
  esc(screen.getByTestId('in'));
  expect(popup).toHaveBeenCalledTimes(1);
  expect(composer).not.toHaveBeenCalled();
});

it('each preview plays from its own element, not a shared "preview" one', async () => {
  const { resetPlayer } = await import('./player.ts');
  const made: string[] = [];
  vi.stubGlobal('Audio', class { paused = true; currentTime = 0; src: string; constructor(src: string) { this.src = src; made.push(src); } pause() {} play() { this.paused = false; return Promise.resolve(); } addEventListener() {} });
  render(<div>{bar({ ...preview, url: 'blob:one' } as never)}{bar({ ...preview, url: 'blob:two' } as never)}</div>);
  for (const b of screen.getAllByRole('button', { name: 'Play' })) fireEvent.click(b);
  expect(made).toEqual(['blob:one', 'blob:two']);
  resetPlayer();
  vi.unstubAllGlobals();
});
