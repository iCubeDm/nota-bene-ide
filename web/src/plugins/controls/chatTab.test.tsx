import { act, cleanup, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES, type ServerEvent } from '@nota-bene/shared';
import { makeStore } from '@/core/testing';
import { chatTab } from './chatTab.tsx';

afterEach(cleanup);

it('issue 644: the chat\'s tab shows its agent\'s vendor mark once the hello names it', () => {
  let ev!: (e: ServerEvent) => void;
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, onEvent: (e: ServerEvent) => void, onState: (s: 'open') => void) => { ev = onEvent; onState('open'); return { send: () => true, close() {} }; }) as never });
  const Icon = chatTab.Icon!;
  const { container } = render(<Provider store={store}><Icon tab={{ id: 'chat', kind: 'chat' }} /></Provider>);
  expect(container.querySelector('[data-agent-icon]')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull(); // the chat's own icon until then
  act(() => ev({ kind: 'hello', protocol: 5, capabilities: CLAUDE_CAPABILITIES })); // Claude's names no provider
  expect(container.querySelector('[data-agent-icon]')?.getAttribute('data-agent-icon')).toBe('claude');
  act(() => ev({ kind: 'hello', protocol: 5, capabilities: { ...CLAUDE_CAPABILITIES, provider: 'codex' } }));
  expect(container.querySelector('[data-agent-icon]')?.getAttribute('data-agent-icon')).toBe('codex');
});
