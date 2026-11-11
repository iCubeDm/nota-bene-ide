import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, PromptEntry } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Composer } from './Composer.tsx';
import { historySlice } from './history.ts';
import { promptHistoryModal } from './historyModal.ts';

beforeEach(() => { setLang('en'); vi.stubGlobal('fetch', vi.fn(async () => new Response('{"prompts":[]}'))); });
afterEach(() => { cleanup(); promptHistoryModal.close(); vi.unstubAllGlobals(); });

function store() {
  const s = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (st: 'open') => void) => (onState('open'), { send: (_m: ClientMessage) => true, close() {} })) as never });
  act(() => {
    s.dispatch(serverEvent({ kind: 'hello', protocol: 16 }));
    s.dispatch(serverEvent({ kind: 'session', id: 's1', root: '/p', title: null, model: null }));
    s.dispatch(historySlice.actions.loaded([{ id: '1', ts: Date.now(), text: 'old', src: 'typed' } as PromptEntry]));
  });
  return s;
}
const fieldOf = (el: HTMLElement) => el.closest('[data-testid="field-box"]') as HTMLElement;

it('the composer history button and mic are inside the field box, the box first in its row', () => {
  render(<Provider store={store()}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  const f = fieldOf(screen.getByRole('textbox'));
  expect(f).not.toBeNull();
  expect(f).toContainElement(screen.getByTestId('prompt-history'));
  expect(f).toContainElement(screen.getByTestId('mic'));
  expect(f.parentElement!.firstElementChild).toBe(f); // nothing left of the box: pinned attachments share its left edge
  expect(f.parentElement).not.toContainElement(screen.queryByTestId('composer-thumbs'));
  expect(f).not.toContainElement(screen.getByLabelText('Send'));
});

it('the field box keeps its classes and the textarea its padding when the mic hides on the first typed character', async () => {
  render(<Provider store={store()}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
  const f = fieldOf(ta);
  const before = { box: f.className, area: ta.className, style: f.getAttribute('style') };
  await userEvent.type(ta, 'x');
  expect(screen.queryByTestId('mic')).toBeNull();
  expect({ box: f.className, area: ta.className, style: f.getAttribute('style') }).toEqual(before);
});

it('the history list anchors to the field box', async () => {
  render(<Provider store={store()}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  await userEvent.click(screen.getByTestId('prompt-history'));
  expect(await screen.findByRole('combobox')).toBeVisible();
  expect(screen.getByTestId('prompt-history').getAttribute('aria-expanded')).toBe('true');
});

it('the comment popup mic is inside its field box', () => {
  const s = store();
  const pending = { anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 1, quote: 'q', prefix: '', suffix: '' }, rect: { left: 1, right: 2, top: 1, bottom: 2, width: 1, height: 1, x: 1, y: 1, toJSON() {} } as DOMRect };
  render(<Provider store={s}><TooltipProvider><CommentPopup pending={pending as never} onClose={() => {}} /></TooltipProvider></Provider>);
  expect(fieldOf(screen.getByPlaceholderText('Comment…'))).toContainElement(screen.getByTestId('popup-mic'));
});
