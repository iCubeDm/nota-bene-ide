import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { CLAUDE_CAPABILITIES } from '@nota-bene/shared';
import { App } from '@/App.tsx';
import { selectTabs } from '@/tabs/slice.ts';

const now = Date.now();
const WINDOWS = [
  { port: 4777, root: '/Users/me/a', pid: 1, startedAt: now - 3 * 3600_000, current: true, state: 'live', session: 's', title: 'Mine', supervised: true, busy: false, clients: 1 },
  { port: 4778, root: '/Users/me/b', pid: 2, startedAt: now - 5 * 60_000, current: false, state: 'live', session: 't', title: 'Other', supervised: true, busy: true, clients: 0 },
  { port: 4779, root: '/Users/me/c', pid: 3, startedAt: now, current: false, state: 'stale', session: null, title: null, supervised: false, busy: false, clients: 0 },
];
let posts: { url: string; body: unknown }[];
let actionReply: () => Response;
let prefsReply: () => Response;
let storage: { unreferenced: { files: number; bytes: number } };
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  posts = [];
  actionReply = () => Response.json({ status: 200 });
  prefsReply = () => Response.json({ defaultMode: 'plan' });
  storage = { unreferenced: { files: 3, bytes: 3_000_000 } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === '/system/storage/clean') return Response.json({ moved: 3, bytes: 3_000_000, trash: '/Users/me/.nota-bene/trash/attachments/x' });
      if (url === '/system/prefs') return prefsReply();
      return actionReply();
    }
    if (url === '/system/windows') return Response.json(WINDOWS);
    if (url === '/system/storage') return Response.json({ attachments: { bytes: 5e6, files: 9 }, comments: { bytes: 2e4, files: 3 }, history: { bytes: 4096, files: 2 }, trash: { bytes: 0, files: 0 }, marks: { bytes: 1e6, files: 4, root: '/Users/me/a' }, ...storage });
    if (url === '/system/about') return Response.json({ version: 'v0.9-12-gabc', stateDir: '/Users/me/.nota-bene', logs: [], node: 'v23.6.0', pid: 42 });
    if (url === '/system/prefs') return Response.json({ defaultMode: 'auto' });
    return new Response('[]');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** ⚙ is a menu: its last item opens the tab */
function openTab() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Settings' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: 'All settings…' }));
}
function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><App /></Provider>);
  openTab();
  return store;
}
const win = async (port: number) => (await screen.findByText(`:${port}`)).closest<HTMLElement>('[data-window]')!;

it('⚙ → All settings opens one Settings tab; a second time activates the same one; it closes like a file tab', () => {
  const store = setup();
  openTab();
  expect(selectTabs(store.getState()).open.filter((t) => t.kind === 'settings')).toHaveLength(1);
  expect(selectTabs(store.getState()).active).toBe('settings');
  expect(screen.getByRole('tab', { name: /Settings/ })).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('tab', { name: /Settings/ })).getByRole('button', { name: 'Close' }));
  expect(selectTabs(store.getState()).open.map((t) => t.id)).toEqual(['chat']);
});

it('Windows: this window has no actions; another one can be restarted or stopped, sending the row it showed; a stale one only says so', async () => {
  setup();
  expect(within(await win(4777)).getByText('this window')).toBeInTheDocument();
  expect(within(await win(4777)).queryByRole('button')).toBeNull();
  const other = await win(4778);
  expect(other).toHaveTextContent('Other · working · no tab · up 5 min');
  expect(within(await win(4779)).getByText('gone')).toBeInTheDocument();
  expect(within(await win(4779)).queryByRole('button')).toBeNull();
  const row = { port: 4778, root: '/Users/me/b', pid: 2, startedAt: WINDOWS[1]!.startedAt };
  // B is working: even a restart asks first, and says the running turn is interrupted
  fireEvent.click(within(other).getByRole('button', { name: 'Restart agent' }));
  let dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('Its agent is working: the running turn is interrupted.');
  expect(posts).toEqual([]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Restart agent' }));
  await waitFor(() => expect(posts).toContainEqual({ url: '/system/windows/action', body: { ...row, action: 'restart-agent' } }));
  // while it is in flight the row's buttons are off: no double relay
  expect(within(other).getByRole('button', { name: 'Stop' })).toBeDisabled();
  expect(await screen.findByText('Sent')).toHaveAttribute('role', 'status');
  await waitFor(() => expect(within(other).getByRole('button', { name: 'Stop' })).toBeEnabled(), { timeout: 3000 });
  fireEvent.click(within(other).getByRole('button', { name: 'Stop' }));
  dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('Stop the window on port 4778 (~/b)?');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(posts).toContainEqual({ url: '/system/windows/action', body: { ...row, action: 'stop' } }));
});

it('Windows: a changed window and a window too old for the control route say so', async () => {
  WINDOWS[1]!.busy = false;
  try {
    setup();
    const other = await win(4778);
    actionReply = () => new Response('window changed', { status: 409 });
    fireEvent.click(within(other).getByRole('button', { name: 'Restart agent' }));
    expect(await screen.findByText(/That window has changed since the list was loaded/)).toBeInTheDocument();
    await waitFor(() => expect(within(other).getByRole('button', { name: 'Restart agent' })).toBeEnabled(), { timeout: 3000 });
    actionReply = () => Response.json({ status: 403 }, { status: 502 });
    fireEvent.click(within(other).getByRole('button', { name: 'Restart agent' }));
    expect(await screen.findByText(/was started before Settings could control it/)).toBeInTheDocument();
  } finally {
    WINDOWS[1]!.busy = true;
  }
});

it('Storage: sizes, and the clean asks first, then reports where the files went', async () => {
  setup();
  expect(await screen.findByText('Media marks of this project')).toBeInTheDocument();
  expect(screen.getByText('Chat history before compaction')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Clean unreferenced files · 3/ }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('Move 3 files (3.0 MB) to the trash');
  expect(posts).toEqual([]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clean unreferenced files' }));
  expect(await screen.findByText('Moved 3 (3.0 MB) to ~/.nota-bene/trash/attachments/x')).toHaveAttribute('role', 'status');
});

it('Defaults: the update check is switched on the server; the variable leaves the box off with the reason', async () => {
  let prefs: unknown = { defaultMode: 'auto', updateCheck: true, updateCheckForcedOff: false };
  const real = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => (url === '/system/prefs' && !init?.method ? Response.json(prefs) : real(url, init)));
  const seen = vi.fn();
  window.addEventListener('nb-update-recheck', seen);
  setup();
  const box = await screen.findByRole('checkbox', { name: 'Check npm for new versions' });
  expect(box).toBeChecked();
  prefs = { defaultMode: 'auto', updateCheck: false, updateCheckForcedOff: false };
  fireEvent.click(box);
  await waitFor(() => expect(posts).toContainEqual({ url: '/system/prefs', body: { updateCheck: false } }));
  await waitFor(() => expect(seen).toHaveBeenCalled());
  await waitFor(() => expect(box).not.toBeChecked());
  window.removeEventListener('nb-update-recheck', seen);
  cleanup();
  prefs = { defaultMode: 'auto', updateCheck: false, updateCheckForcedOff: true };
  setup();
  expect(await screen.findByRole('checkbox', { name: 'Check npm for new versions' })).toBeDisabled();
  expect(screen.getByText('Off by NOTA_BENE_NO_UPDATE_CHECK')).toBeInTheDocument();
});

it('Defaults: the audit log is on by default, names its folder and is switched on the server', async () => {
  let prefs: unknown = { defaultMode: 'auto', audit: true, auditDir: '/home/u/.nota-bene/audit' };
  const real = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => (url === '/system/prefs' && !init?.method ? Response.json(prefs) : real(url, init)));
  setup();
  const box = await screen.findByRole('checkbox', { name: 'Write an audit log of system events' });
  expect(box).toBeChecked();
  expect(screen.getByText(/to \/home\/u\/\.nota-bene\/audit, one file a day/)).toBeInTheDocument();
  prefs = { defaultMode: 'auto', audit: false, auditDir: '/home/u/.nota-bene/audit' };
  fireEvent.click(box);
  await waitFor(() => expect(posts).toContainEqual({ url: '/system/prefs', body: { audit: false } }));
  await waitFor(() => expect(box).not.toBeChecked());
});

it('Defaults: the mode is saved on the server; About shows the version', async () => {
  setup();
  const mode = await screen.findByRole('combobox', { name: 'Agent mode for projects without their own' });
  fireEvent.change(mode, { target: { value: 'plan' } });
  await waitFor(() => expect(posts).toContainEqual({ url: '/system/prefs', body: { defaultMode: 'plan' } }));
  expect(await screen.findByText('v0.9-12-gabc')).toBeInTheDocument();
  // a failed save says so (the select snaps back to the stored value)
  prefsReply = () => new Response('no', { status: 500 });
  fireEvent.change(mode, { target: { value: 'default' } });
  expect(await screen.findByText('Could not load: 500')).toBeInTheDocument();
  expect(screen.getByText(/in the Claude Code task/)).toBeInTheDocument();
  act(() => void fireEvent.change(screen.getByRole('combobox', { name: 'Interface language' }), { target: { value: 'ru' } }));
  expect(await screen.findByText('Окна')).toBeInTheDocument();
});

it('About names the agent of the window where a log would be', async () => {
  const store = setup();
  expect(await screen.findByText(/in the Claude Code task/)).toBeInTheDocument();
  act(() => void store.dispatch(serverEvent({ kind: 'hello', protocol: 12, capabilities: { ...CLAUDE_CAPABILITIES, provider: 'codex' } })));
  expect(await screen.findByText(/in the Codex task/)).toBeInTheDocument();
});

it('the language select follows a change made elsewhere (a hello), with no copy of its own', async () => {
  setup();
  const sel = (await screen.findByRole('combobox', { name: 'Interface language' })) as HTMLSelectElement;
  expect(sel.value).toBe('en');
  act(() => setLang('ru')); // what adoptServerLang does when the server's value arrives
  expect(await screen.findByDisplayValue('Русский')).toBeInTheDocument();
});
