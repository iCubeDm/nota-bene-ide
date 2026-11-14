import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteState } from '@nota-bene/shared';
import { App } from '@/App.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { selectTabs } from '@/tabs/slice.ts';

const OFF: RemoteState = {
  configured: false, enabled: true, running: false, online: false, relay: null, hostFingerprint: null, devices: [],
  pairing: null, legacy: false, lastError: null, startFailed: false, accessKey: false,
};
const ONLINE: RemoteState = {
  ...OFF, configured: true, running: true, online: true, relay: 'wss://relay.example.com', hostFingerprint: 'abcd-efgh-ijkl-mnop',
  devices: [
    { id: 'aaaa', name: 'Test phone', fingerprint: 'qrst-uvwx-yz23-4567', online: true, pairedAt: Date.UTC(2026, 0, 2) },
    { id: 'bbbb', fingerprint: 'zzzz-yyyy-xxxx-wwww', online: true, pairedAt: 0 },
  ],
};

let posts: { url: string; body: unknown }[];
let answer: (url: string, body: unknown) => Response;
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  posts = [];
  answer = () => Response.json({ state: ONLINE, stopped: null });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body: unknown = JSON.parse(String(init.body ?? '{}'));
      posts.push({ url, body });
      return answer(url, body);
    }
    return new Response('[]');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(o: { protocol?: number; state?: RemoteState } = {}) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><App /></Provider>);
  act(() => {
    store.dispatch(serverEvent({ kind: 'hello', protocol: o.protocol ?? 20 }));
    if (o.state) store.dispatch(serverEvent({ kind: 'remote', state: o.state }));
  });
  return store;
}
const btn = () => document.getElementById('remoteBtn');
const open = () => fireEvent.click(btn()!);

describe('header indicator', () => {
  it('is hidden for a server older than protocol 20', () => {
    setup({ protocol: 19, state: ONLINE });
    expect(btn()).toBeNull();
  });

  it.each([
    ['off', OFF, /Remote access is off/],
    ['connecting', { ...ONLINE, online: false, devices: [] }, /connecting to the relay/],
    ['online', { ...ONLINE, devices: [] }, /^Remote access: online$/],
    ['trouble', { ...ONLINE, online: false, running: false, lastError: { code: 4402, message: 'the relay does not admit this host', at: 1 } }, /not working: the relay does not admit this host/],
    ['trouble', { ...ONLINE, online: false, running: false, startFailed: true }, /connector\.log/],
  ] as [string, RemoteState, RegExp][])('%s', (want, state, tip) => {
    setup({ state });
    expect(btn()!.dataset.state).toBe(want);
    expect(btn()!.title).toMatch(tip);
    expect(btn()!.querySelector('[data-dot]') !== null).toBe(want !== 'off');
  });

  it('off when access is turned off, even with a relay saved', () => {
    setup({ state: { ...ONLINE, enabled: false } });
    expect(btn()!.dataset.state).toBe('off');
  });

  it('online shows how many phones are connected; a click opens one Remote tab', () => {
    const store = setup({ state: ONLINE });
    expect(btn()!.querySelector('[data-phones]')!.textContent).toBe('2');
    expect(btn()!.title).toMatch(/phones connected: 2/);
    open();
    open();
    expect(selectTabs(store.getState()).active).toBe('remote');
    expect(selectTabs(store.getState()).open.filter((t) => t.kind === 'remote')).toHaveLength(1);
  });
});

describe('Remote tab', () => {
  it('without a relay: the field, Save, a guide link; Save posts the address and a refusal is shown', async () => {
    setup({ state: OFF });
    open();
    expect(screen.getByRole('link', { name: 'How to set up a relay' }).getAttribute('href')).toMatch(/guide\.md#remote-access$/);
    expect(document.getElementById('remotePair')).toBeNull();
    answer = () => Response.json({ error: 'the relay must be a wss:// URL' }, { status: 400 });
    fireEvent.change(screen.getByLabelText('Relay'), { target: { value: ' http://relay.example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the relay must be a wss:// URL');
    expect(posts).toEqual([{ url: '/remote/config', body: { relay: 'http://relay.example.com' } }]);
  });

  it('the switch posts access off, and says so when it stopped a terminal\'s connector', async () => {
    setup({ state: ONLINE });
    open();
    answer = () => Response.json({ state: { ...ONLINE, enabled: false }, stopped: 'hand' });
    fireEvent.click(screen.getByLabelText('Allow access from paired phones'));
    expect(await screen.findByText('The connector that was started in a terminal has been stopped.')).toBeTruthy();
    expect(posts).toEqual([{ url: '/remote/config', body: { enabled: false } }]);
  });

  it('a terminal connector of an older version: the switch is disabled, with the reason', () => {
    setup({ state: { ...ONLINE, legacy: true } });
    open();
    expect((screen.getByLabelText('Allow access from paired phones') as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById('remoteLegacy')).toHaveTextContent(/older version/);
  });

  it('pairing shows the server\'s QR, the code text and the fingerprint; the outcome replaces it', async () => {
    const store = setup({ state: ONLINE });
    open();
    answer = (url) => (url === '/remote/pair'
      ? Response.json({ uri: 'nbremote://pair?v=1&r=x', qr: '<svg data-test-qr="1"></svg>', hostFingerprint: 'abcd-efgh-ijkl-mnop', expiresAt: Date.now() + 5 * 60_000 })
      : Response.json({ ok: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }));
    await waitFor(() => expect(document.querySelector('#remoteQr svg[data-test-qr]')).not.toBeNull());
    expect(document.getElementById('remoteUri')).toHaveTextContent('nbremote://pair?v=1&r=x');
    expect(screen.getByText('Scan the code with the Nota Bene app within 5 min.')).toBeTruthy();
    act(() => { store.dispatch(serverEvent({ kind: 'remote-pair', result: 'refused', fingerprint: 'evil-evil-evil-evil' })); });
    expect(document.getElementById('remotePairOutcome')).toHaveTextContent('evil-evil-evil-evil');
    expect(document.getElementById('remoteQr')).not.toBeNull(); // a refusal keeps the code
    act(() => { store.dispatch(serverEvent({ kind: 'remote-pair', result: 'paired', device: { id: 'cccc', name: 'New phone', fingerprint: 'nnnn-nnnn-nnnn-nnnn', online: true, pairedAt: 1 } })); });
    expect(document.getElementById('remoteQr')).toBeNull();
    expect(document.getElementById('remotePairOutcome')).toHaveTextContent('Paired New phone, fingerprint nnnn-nnnn-nnnn-nnnn');
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeTruthy();
  });

  it('cancel withdraws the code', async () => {
    setup({ state: ONLINE });
    open();
    answer = (url) => (url === '/remote/pair'
      ? Response.json({ uri: 'nbremote://pair?v=1', qr: '<svg></svg>', hostFingerprint: 'abcd-efgh-ijkl-mnop', expiresAt: Date.now() + 60_000 })
      : Response.json({ ok: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }));
    await waitFor(() => expect(document.getElementById('remoteQr')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.getElementById('remoteQr')).toBeNull();
    expect(posts.map((p) => p.url)).toEqual(['/remote/pair', '/remote/pair/cancel']);
  });

  it('pairing waits for the connector online; another window\'s pairing is named', () => {
    const store = setup({ state: { ...ONLINE, online: false } });
    open();
    expect((screen.getByRole('button', { name: 'Pair a phone' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => { store.dispatch(serverEvent({ kind: 'remote', state: { ...ONLINE, pairing: { expiresAt: 1, mine: false } } })); });
    expect(screen.getByText('A pairing is in progress in another window.')).toBeTruthy();
  });

  it('phones: name, fingerprint, online; Revoke asks first, then posts the id', async () => {
    setup({ state: ONLINE });
    open();
    const row = document.querySelector('[data-phone="aaaa"]')!;
    expect(row).toHaveTextContent('Test phone');
    expect(row).toHaveTextContent('qrst-uvwx-yz23-4567');
    expect(row).toHaveTextContent('online');
    expect(document.querySelector('[data-phone="bbbb"]')).toHaveTextContent('a phone');
    answer = () => Response.json({ ok: true });
    fireEvent.click(row.querySelector('button')!);
    expect(posts).toEqual([]);
    expect(row).toHaveTextContent('Revoke this phone?');
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await waitFor(() => expect(posts).toEqual([{ url: '/remote/revoke', body: { id: 'aaaa' } }]));
  });

  it('an older server: the tab says to restart it', () => {
    const store = setup({ protocol: 20, state: ONLINE });
    open();
    act(() => { store.dispatch(serverEvent({ kind: 'hello', protocol: 19 })); });
    expect(screen.getByText(/older than remote access from the window/)).toBeTruthy();
  });
});
