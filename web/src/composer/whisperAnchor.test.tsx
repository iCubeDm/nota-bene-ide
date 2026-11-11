import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import type { RefObject } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { Composer } from './Composer.tsx';

const anchors: RefObject<HTMLElement | null>[] = [];
vi.mock('@/voice/WhisperPrompt.tsx', () => ({
  WhisperPrompt: ({ anchor }: { anchor: RefObject<HTMLElement | null> }) => (anchors.push(anchor), null),
}));

beforeEach(() => { setLang('en'); anchors.length = 0; });
afterEach(cleanup);

it('the Whisper prompt anchors to the field once the mic is gone (text typed while it is open)', async () => {
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (_m: ClientMessage) => true, close() {} })) as never });
  store.dispatch({ type: 'server/event', payload: { kind: 'hello', protocol: 16 } }); // voice, but no Whisper
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  fireEvent.click(screen.getByTestId('mic'));
  await userEvent.type(screen.getByRole('textbox'), 'x');
  expect(screen.queryByTestId('mic')).toBeNull();
  act(() => {});
  expect(anchors.at(-1)!.current).toBe(screen.getByRole('textbox'));
});
