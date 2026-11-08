import { act, cleanup, render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { connState, makeStore, serverEvent } from '@/store/store.ts';
import { draftSent, setBuilding, setDraft, uploadStarted } from '@/composer/slice.ts';
import { reloadPage } from './reloadPage.ts';
import { recheckUpdate, UpdateNotice } from './UpdateNotice.tsx';

vi.mock('./reloadPage.ts', () => ({ reloadPage: vi.fn() }));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let answer: unknown;
const status = { current: '1.2.0', latest: '1.3.0', phase: 'available', canUpdate: false, auto: false, busy: false, log: '/state/update.log' };
let store: ReturnType<typeof makeStore>;
const render = (ui: React.ReactElement) => rtlRender(<Provider store={store}>{ui}</Provider>);
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  answer = status;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(reloadPage).mockClear();
});

const button = () => screen.findByRole('button', { name: '↑ 1.3.0' });

it('a newer version: the header says so, and the popover says how to update', async () => {
  render(<UpdateNotice />);
  await userEvent.click(await button());
  expect(screen.getByText('npm i -g nota-bene-ide@1.3.0')).toBeInTheDocument();
  expect(screen.getByText(/You run 1\.2\.0/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', expect.stringContaining('/releases/tag/v1.3.0'));
});

it('no newer version, or a server that cannot say: nothing shows', async () => {
  answer = { ...status, current: '1.3.0', latest: null, phase: 'none' };
  const { container, unmount } = render(<UpdateNotice />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
  unmount();
  vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 500 }));
  const again = render(<UpdateNotice />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(again.container).toBeEmptyDOMElement();
});

it('turned off in Settings: the notice goes without waiting for a focus', async () => {
  render(<UpdateNotice />);
  await button();
  answer = { ...status, latest: null, phase: 'none' };
  act(() => recheckUpdate());
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: '↑ 1.3.0' })).toBeNull());
});

it('Later hides this version across a reload, and the next version shows again', async () => {
  const { unmount } = render(<UpdateNotice />);
  await userEvent.click(await button());
  await userEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.queryByRole('button', { name: '↑ 1.3.0' })).toBeNull();
  unmount();
  const asks = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/system/update')).length;
  render(<UpdateNotice />);
  await vi.waitFor(() => expect(asks()).toBe(2));
  expect(screen.queryByRole('button', { name: '↑ 1.3.0' })).toBeNull();
  cleanup();
  answer = { ...status, latest: '1.4.0' };
  render(<UpdateNotice />);
  expect(await screen.findByRole('button', { name: '↑ 1.4.0' })).toBeInTheDocument();
});

it('the popover shows what the newer version changes, asked once when it opens', async () => {
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/system/update/changes')
    ? { text: '## 1.3.0 — 2026-11-02\n\n- Themes: Darcula is the new default.' }
    : answer)));
  render(<UpdateNotice />);
  await userEvent.click(await button());
  const box = await screen.findByTestId('update-changes');
  expect(box).toHaveTextContent('Themes: Darcula is the new default.');
  expect(screen.getByRole('region', { name: 'What’s new' })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  await userEvent.click(await button());
  const asked = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/system/update/changes'));
  expect(asked).toHaveLength(1);
});

it('no changelog to be had: the popover is as before', async () => {
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/system/update/changes') ? { text: null } : answer)));
  render(<UpdateNotice />);
  await userEvent.click(await button());
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/changes'))).toBe(true));
  expect(screen.queryByTestId('update-changes')).toBeNull();
  expect(screen.getByRole('link', { name: 'Release notes' })).toBeInTheDocument();
});

const posted = () => vi.mocked(fetch).mock.calls.filter(([, i]) => i?.method === 'POST').map(([u, i]) => [String(u), i?.body ? JSON.parse(String(i.body)) : undefined]);
const asks = (path: string) => vi.mocked(fetch).mock.calls.filter(([u, i]) => String(u) === path && !i?.method).length;

it('offers Update and the checkbox when the window can update', async () => {
  answer = { ...status, canUpdate: true };
  vi.mocked(fetch).mockImplementation(async (url, init) => init?.method === 'POST'
    ? new Response(String(url).endsWith('/install') ? JSON.stringify({ ...status, canUpdate: true, phase: 'installing' }) : null, { status: String(url).endsWith('/install') ? 200 : 204 })
    : new Response(JSON.stringify(answer)));
  render(<UpdateNotice />);
  await userEvent.click(await button());
  expect(screen.queryByText('npm i -g nota-bene-ide@1.3.0')).toBeNull();
  expect(screen.getByText('You run 1.2.0.')).toBeInTheDocument(); // no "In a terminal install:" without the command
  await userEvent.click(screen.getByRole('checkbox', { name: 'Update automatically' }));
  expect(posted()).toContainEqual(['/system/update/auto', { on: true }]);
  await userEvent.click(screen.getByRole('button', { name: 'Update' }));
  expect(posted()).toContainEqual(['/system/update/install', undefined]);
  expect(await screen.findByText('Updating to 1.3.0…')).toBeInTheDocument();
});

it('keeps the old popover when it cannot', async () => {
  render(<UpdateNotice />);
  await userEvent.click(await button());
  expect(screen.getByText('npm i -g nota-bene-ide@1.3.0')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Update automatically' })).toBeNull();
});

it('shows Updating… and polls while installing', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    answer = { ...status, canUpdate: true, phase: 'installing' };
    render(<UpdateNotice />);
    expect(await screen.findByText('Updating to 1.3.0…')).toBeInTheDocument();
    const before = asks('/system/update');
    await act(() => vi.advanceTimersByTimeAsync(6100));
    expect(asks('/system/update') - before).toBeGreaterThanOrEqual(3);
    answer = { ...status, canUpdate: true, phase: 'ready' };
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText('1.3.0 is ready')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('ready: restarts by itself when idle and the composer is empty', async () => {
  answer = { ...status, canUpdate: true, phase: 'ready' };
  render(<UpdateNotice />);
  await vi.waitFor(() => expect(posted()).toContainEqual(['/system/update/restart', undefined]));
});

it('ready: a draft in the composer, a waiting approval or a busy agent hold the restart; Restart is off while busy', async () => {
  answer = { ...status, canUpdate: true, phase: 'ready' };
  act(() => void store.dispatch(setDraft('half a thought')));
  const { unmount } = render(<UpdateNotice />);
  await screen.findByText('1.3.0 is ready');
  await new Promise((r) => setTimeout(r, 50));
  expect(posted()).toEqual([]);
  unmount();

  act(() => void store.dispatch(setDraft('')));
  act(() => void store.dispatch(serverEvent({ kind: 'permission', id: 'p1', toolName: 'Bash', input: {}, ts: 0 })));
  const second = render(<UpdateNotice />);
  await screen.findByText('1.3.0 is ready');
  await new Promise((r) => setTimeout(r, 50));
  expect(posted()).toEqual([]);
  second.unmount();

  store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  answer = { ...status, canUpdate: true, phase: 'ready', busy: true };
  render(<UpdateNotice />);
  const restart = await screen.findByRole('button', { name: 'Restart' });
  expect(restart).toBeDisabled();
  expect(restart).toHaveAttribute('title', 'After the agent and running commands finish');
  await new Promise((r) => setTimeout(r, 50));
  expect(posted()).toEqual([]);
});

it('ready: an upload, a send not yet echoed, a combined image being built, a running ! command or task hold the restart', async () => {
  answer = { ...status, canUpdate: true, phase: 'ready' };
  const holds: [string, () => void][] = [
    ['upload', () => store.dispatch(uploadStarted())],
    ['unconfirmed send', () => store.dispatch(draftSent({ id: 'u1', text: 'hi', images: [], commentIds: [] }))],
    ['building', () => store.dispatch(setBuilding(true))],
    ['! command', () => store.dispatch(serverEvent({ kind: 'shell-start', id: 's1', cmd: 'npm test', ts: 1 }))],
    ['task', () => store.dispatch(serverEvent({ kind: 'agent', e: { t: 'task', id: 't1', phase: 'started', desc: 'build', type: 'local_bash' }, ts: 1 }))],
  ];
  for (const [what, hold] of holds) {
    store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
    act(hold);
    const { unmount } = render(<UpdateNotice />);
    await screen.findByText('1.3.0 is ready');
    await new Promise((r) => setTimeout(r, 50));
    expect(posted(), what).toEqual([]);
    unmount();
  }
});

it('ready: the Restart button restarts at once', async () => {
  answer = { ...status, canUpdate: true, phase: 'ready' };
  act(() => void store.dispatch(setDraft('keep me')));
  render(<UpdateNotice />);
  await userEvent.click(await screen.findByRole('button', { name: 'Restart' }));
  expect(posted()).toContainEqual(['/system/update/restart', undefined]);
});

it('failed and rolled back name the log', async () => {
  answer = { ...status, canUpdate: true, phase: 'failed', failed: '1.3.0' };
  const { unmount } = render(<UpdateNotice />);
  await userEvent.click(await screen.findByRole('button', { name: 'Update failed' }));
  expect(screen.getByText('Log: /state/update.log')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
  unmount();
  answer = { ...status, canUpdate: true, phase: 'rolled-back', rolledBack: '1.3.0' };
  render(<UpdateNotice />);
  await userEvent.click(await screen.findByRole('button', { name: 'Update to 1.3.0 was rolled back' }));
  expect(screen.getByText('Log: /state/update.log')).toBeInTheDocument();
});

it('Updated to shows once per window and version', async () => {
  answer = { ...status, current: '1.3.0', latest: null, phase: 'none', canUpdate: true, updatedFrom: '1.2.0' };
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).startsWith('/system/update/changes')
    ? { text: '## 1.3.0 — 2026-11-02\n\n- Themes: Darcula is the new default.' }
    : answer)));
  const { unmount } = render(<UpdateNotice />);
  await userEvent.click(await screen.findByRole('button', { name: 'Updated to 1.3.0' }));
  expect(await screen.findByTestId('update-changes')).toHaveTextContent('Themes: Darcula');
  expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === '/system/update/changes?from=1.2.0')).toBe(true);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: 'Updated to 1.3.0' })).toBeNull();
  expect(Object.keys(localStorage).some((k) => /^nb\.updated\..*1\.3\.0$/.test(k))).toBe(true);
  unmount();
  const again = render(<UpdateNotice />);
  await vi.waitFor(() => expect(asks('/system/update')).toBeGreaterThanOrEqual(2));
  expect(again.container).toBeEmptyDOMElement();
});

it('after a handover the page reloads itself once it reconnects to the new version, when idle', async () => {
  answer = { ...status, latest: null, phase: 'none', canUpdate: true };
  act(() => void store.dispatch(connState('open')));
  render(<UpdateNotice />);
  await vi.waitFor(() => expect(asks('/system/update')).toBe(1));
  answer = { ...status, current: '1.3.0', latest: null, phase: 'none', canUpdate: true, updatedFrom: '1.2.0' };
  act(() => void store.dispatch(connState('closed')));
  act(() => void store.dispatch(connState('open'))); // the server of the new version answers
  await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
});

it('after a handover with a draft the page stays, and Updated to offers Reload', async () => {
  answer = { ...status, latest: null, phase: 'none', canUpdate: true };
  act(() => void store.dispatch(setDraft('half a thought')));
  act(() => void store.dispatch(connState('open')));
  render(<UpdateNotice />);
  await vi.waitFor(() => expect(asks('/system/update')).toBe(1));
  answer = { ...status, current: '1.3.0', latest: null, phase: 'none', canUpdate: true, updatedFrom: '1.2.0' };
  act(() => void store.dispatch(connState('closed')));
  act(() => void store.dispatch(connState('open')));
  const reload = await screen.findByRole('button', { name: 'Reload' });
  expect(screen.getByRole('button', { name: 'Updated to 1.3.0' })).toBeInTheDocument();
  expect(reloadPage).not.toHaveBeenCalled();
  await userEvent.click(reload);
  expect(reloadPage).toHaveBeenCalledTimes(1);
});

it('a page loaded on the new version never reloads', async () => {
  answer = { ...status, current: '1.3.0', latest: null, phase: 'none', canUpdate: true, updatedFrom: '1.2.0' };
  act(() => void store.dispatch(connState('open')));
  render(<UpdateNotice />);
  await screen.findByRole('button', { name: 'Updated to 1.3.0' });
  act(() => void store.dispatch(connState('closed')));
  act(() => void store.dispatch(connState('open')));
  await vi.waitFor(() => expect(asks('/system/update')).toBe(2));
  expect(reloadPage).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
});

it('a source checkout whose version changed does not reload', async () => {
  answer = { ...status, current: 'v1.2.0-3-gabc', latest: null, phase: 'none' };
  act(() => void store.dispatch(connState('open')));
  render(<UpdateNotice />);
  await vi.waitFor(() => expect(asks('/system/update')).toBe(1));
  answer = { ...status, current: 'v1.2.0-4-gdef', latest: null, phase: 'none' };
  act(() => void store.dispatch(connState('closed')));
  act(() => void store.dispatch(connState('open')));
  await vi.waitFor(() => expect(asks('/system/update')).toBe(2));
  await new Promise((r) => setTimeout(r, 50));
  expect(reloadPage).not.toHaveBeenCalled();
});
