import { expect, it } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { sendVoice } from './send.ts';

const voice = { id: 'a'.repeat(64), ms: 3000, wave: [1, 2, 3] };

function setup(protocol: number, dictationLang?: string) {
  setLang('ru');
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  store.dispatch(serverEvent({ kind: 'hello', protocol, ...(dictationLang ? { dictationLang } : {}) }));
  store.dispatch(sendVoice(voice, 'm1'));
  return sent[0] as Extract<ClientMessage, { type: 'send' }>;
}

it('Auto (nothing chosen, or auto): detects, the UI language is the hint', () => {
  expect(setup(18)).toMatchObject({ lang: 'ru', detect: true });
  expect(setup(18, 'auto')).toMatchObject({ lang: 'ru', detect: true });
});

it('a pinned language is sent as lang, without detect', () => {
  const m = setup(18, 'de');
  expect(m.lang).toBe('de');
  expect(m.detect).toBeUndefined();
});

it('a server older than protocol 18 gets the UI language and no detect', () => {
  const m = setup(17, 'auto');
  expect(m.lang).toBe('ru');
  expect(m.detect).toBeUndefined();
});
