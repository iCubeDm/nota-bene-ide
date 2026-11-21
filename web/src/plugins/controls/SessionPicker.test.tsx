import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/core/components/ui/tooltip.tsx';
import { CommentsPanel } from '@/plugins/comments/CommentsPanel.tsx';
import { Composer } from '@/plugins/composer/Composer.tsx';
import { setDraft } from '@/plugins/composer/slice.ts';
import { setLang } from '@/core/i18n/index.ts';
import { Header } from '@/core/shell/Header.tsx';
import { makeStore } from '@/core/testing';
import { menuItems, SessionPicker, type SessionsView } from './SessionPicker.tsx';
import { ago } from '@/core/lib/format.ts';
import { brief } from '@/core/store/sessions.ts';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const NOW = Date.now();
const A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = '33333333-cccc-4ccc-8ccc-cccccccccccc';
const D = '44444444-dddd-4ddd-8ddd-dddddddddddd';
const E = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';
const VIEW: SessionsView = {
  current: A,
  root: '/Users/me/proj',
  sessions: [
    { id: B, title: 'other one', at: NOW - 5 * 60_000, size: 2_400_000, cwd: '/Users/me/other' },
    { id: A, title: 'current talk', at: NOW, size: 12_000, cwd: '/Users/me/proj' },
    { id: C, title: '', at: NOW - 3 * 3600_000, size: 800, cwd: '/Users/me/proj' },
    { id: D, title: 'third folder', at: NOW - 2 * 86400_000, size: 5000, cwd: '/tmp/x' },
    { id: E, title: 'older here', at: NOW - 3 * 86400_000, size: 3000, cwd: '/Users/me/proj' },
  ],
};

let view: SessionsView;
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  view = VIEW;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/sessions') return new Response(JSON.stringify(view));
    if (url === '/sources') return new Response(JSON.stringify([]));
    return new Response('nope', { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  let state!: (s: 'open' | 'closed') => void;
  const connect = vi.fn((_u: unknown, onEvent: (e: ServerEvent) => void, onState: (s: 'open' | 'closed') => void) => {
    ev = onEvent;
    state = onState;
    onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Header />
        <SessionPicker />
        <Composer />
        <CommentsPanel onSend={() => {}} />
      </TooltipProvider>
    </Provider>,
  );
  const emit = (...es: ServerEvent[]) => act(() => es.forEach(ev));
  emit({ kind: 'hello', protocol: 5 }); // capability-gated controls wait for hello (M7-09)
  emit({ kind: 'session', id: A, root: '/Users/me/proj', title: null, model: null });
  const switches = () => sent.filter((m) => m.type === 'switch');
  return { sent, store, emit, switches, offline: () => act(() => state('closed')) };
}
const btn = () => screen.getByRole('button', { name: 'Sessions' });
const menu = () => screen.getByRole('dialog', { name: 'Sessions' });
it('the Sessions trigger is a ▾ (the chat tab names the session), named but with no tooltip (issue 463)', () => {
  setup();
  expect(btn().textContent).toBe('');
  expect(btn()).toHaveAccessibleName('Sessions');
  expect(btn().title).toBe('');
});

async function openPicker() {
  await userEvent.click(btn());
  await screen.findByText('current talk');
}
const rows = () => [...menu().querySelectorAll('[data-sess-item]')].map((el) => el.querySelector('[data-t]')!.textContent!);

it('only this project\'s sessions: new first, then its sessions; other folders are not offered; meta line id8 · ago · size', async () => {
  setup();
  await openPicker();
  expect(rows()).toEqual(['+ new session in this project', 'current talk', '(untitled)', 'older here']);
  expect(screen.queryByText('other one')).toBeNull();
  expect(screen.queryByText('third folder')).toBeNull();
  const cur = screen.getByText('current talk').closest('button')!;
  expect(cur).toHaveTextContent('11111111 · just now · 12 kB · open now');
  expect(screen.getByText('(untitled)', { selector: '[data-t]' }).closest('button')).toHaveTextContent('33333333 · 3 h ago · 800 B');
  expect(menu().className).toContain('w-[460px]');
});

it('the filter is focused, matches the title and keeps "new"', async () => {
  setup();
  await openPicker();
  const f = screen.getByPlaceholderText('Search by title…');
  await waitFor(() => expect(f).toHaveFocus());
  await userEvent.type(f, 'TALK');
  expect(rows()).toEqual(['+ new session in this project', 'current talk']);
  await userEvent.clear(f);
  await userEvent.type(f, 'other');
  expect(rows()).toEqual(['+ new session in this project']);
  await userEvent.clear(f);
  expect(rows()).toEqual(['+ new session in this project', 'current talk', '(untitled)', 'older here']);
});

it('the current session is inert', async () => {
  const { switches } = setup();
  await openPicker();
  const cur = screen.getByText('current talk').closest('button')!;
  expect(cur).toBeDisabled();
  fireEvent.click(cur);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByText(/Open session/)).toBeNull();
  expect(switches()).toEqual([]);
});

it('a switch in this folder: switching… in the header, the line is off until the window tells the new session', async () => {
  const { switches, emit, store } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('(untitled)', { selector: '[data-t]' }));
  const dlg = await screen.findByRole('dialog', { name: 'Open session “(untitled)”?' });
  await userEvent.click(within(dlg).getByRole('button', { name: 'Switch' }));
  expect(switches()).toEqual([{ type: 'switch', id: C, dir: '/Users/me/proj' }]);
  expect(document.getElementById('conn')).toHaveTextContent('switching…');
  expect(btn()).toBeDisabled();
  emit({ kind: 'replay', events: [] }, { kind: 'session', id: C, root: '/Users/me/proj', title: null, model: null });
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(store.getState().controls.switching).toBeNull();
  expect(btn()).toBeEnabled();
});

it('a session asks, with the warning and without a move line', async () => {
  const { switches } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('(untitled)', { selector: '[data-t]' }));
  const dlg = await screen.findByRole('dialog', { name: 'Open session “(untitled)”?' });
  expect(dlg).not.toHaveTextContent('another folder');
  expect(dlg).toHaveTextContent('Don’t keep this same session open in a terminal claude');
  await userEvent.keyboard('{Enter}');
  expect(switches()).toEqual([{ type: 'switch', id: C, dir: '/Users/me/proj' }]);
});

it('"new session here" sends id null and the root; cancel sends nothing', async () => {
  const { switches } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('+ new session in this project'));
  let dlg = await screen.findByRole('dialog', { name: 'Start a new session?' });
  await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
  expect(switches()).toEqual([]);
  await openPicker();
  await userEvent.click(screen.getByText('+ new session in this project'));
  dlg = await screen.findByRole('dialog', { name: 'Start a new session?' });
  await userEvent.click(within(dlg).getByRole('button', { name: 'Switch' }));
  expect(switches()).toEqual([{ type: 'switch', id: null, dir: '/Users/me/proj' }]);
});

it('disabled while the agent is busy', () => {
  const { emit } = setup();
  expect(btn()).toBeEnabled();
  emit({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  expect(btn()).toBeDisabled();
});

it('while switching: Send (composer and panel) is off with the switching title, the draft stays; a switch error ends it', async () => {
  const { emit, store, sent } = setup();
  act(() => { store.dispatch(setDraft('keep me')); });
  await openPicker();
  await userEvent.click(screen.getByText('(untitled)', { selector: '[data-t]' }));
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch' }));
  const send = screen.getAllByRole('button', { name: 'Send', hidden: true });
  expect(send).toHaveLength(2);
  for (const b of send) {
    expect(b).toBeDisabled();
    expect(b.closest('[title]')).toHaveAttribute('title', 'switching…');
  }
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(box.value).toBe('keep me');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(sent.filter((m) => m.type === 'send')).toEqual([]);
  emit({ kind: 'server-error', where: 'switch', message: 'no session lives in /x' });
  expect(store.getState().controls.switching).toBeNull();
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(screen.getAllByRole('button', { name: 'Send', hidden: true })[0]).toBeEnabled();
  expect(box.value).toBe('keep me');
});

async function confirmOther() {
  await openPicker();
  await userEvent.click(screen.getByText('(untitled)', { selector: '[data-t]' }));
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch' }));
}

it('mid-switch: Compact and the mode pill are off; busy errors (any socket\'s) and an old-session title refresh do not end it', async () => {
  const { emit, store, sent } = setup();
  emit({ kind: 'mode', mode: 'auto' });
  act(() => { store.dispatch(setDraft('keep me')); });
  await confirmOther();
  expect(store.getState().controls.switching).toBe('asked');
  expect(screen.getByRole('button', { name: /Compact context/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Clear context/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^Agent mode/ })).toBeDisabled();
  // a compact (here or in another window) refused as busy, then some other socket's busy send
  emit({ kind: 'server-error', where: 'busy', message: 'the session is switching; the command was not sent' });
  emit({ kind: 'server-error', where: 'busy', message: 'the session is switching; the message was not sent' });
  // the old session's title refresh, before the reset
  emit({ kind: 'session', id: A, root: '/Users/me/proj', title: 'renamed', model: null });
  expect(store.getState().controls.switching).toBe('asked');
  const send = screen.getAllByRole('button', { name: 'Send', hidden: true })[0];
  expect(send).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(sent.filter((m) => m.type === 'send' || m.type === 'command')).toEqual([]);
  expect(store.getState().composer.draft).toBe('keep me');
  // the reset commits it; a busy error still does not end it; the new session does
  emit({ kind: 'replay', events: [] });
  expect(store.getState().controls.switching).toBe('committed');
  emit({ kind: 'server-error', where: 'busy', message: 'x' });
  expect(store.getState().controls.switching).toBe('committed');
  emit({ kind: 'session', id: B, root: '/Users/me/other', title: 'other one', model: null });
  expect(store.getState().controls.switching).toBeNull();
  expect(store.getState().composer.draft).toBe('keep me');
});

it('after the confirm the focus goes to the composer (the picker button is disabled)', async () => {
  setup();
  await confirmOther();
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
});

it('another window switching closes the menu and an open question', async () => {
  const { emit, switches } = setup();
  await openPicker();
  emit({ kind: 'replay', events: [] }, { kind: 'session', id: D, root: '/tmp/x', title: null, model: null });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull());
  await openPicker();
  await userEvent.click(screen.getByText('(untitled)', { selector: '[data-t]' }));
  await screen.findByRole('dialog', { name: 'Open session “(untitled)”?' });
  emit({ kind: 'session', id: C, root: '/Users/me/proj', title: null, model: null });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(switches()).toEqual([]);
});

it('a confirm refused because the agent started meanwhile says so', async () => {
  const { emit, switches } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('(untitled)', { selector: '[data-t]' }));
  const dlg = await screen.findByRole('dialog', { name: 'Open session “(untitled)”?' });
  emit({ kind: 'user', id: 'u1', text: 'from another window', ts: 1 });
  await userEvent.click(within(dlg).getByRole('button', { name: 'Switch' }));
  expect(switches()).toEqual([]);
  expect(screen.getByRole('status')).toHaveTextContent('Could not switch: agent is working…');
});

it('a confirm refused while offline says so', async () => {
  const { switches, offline } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('(untitled)', { selector: '[data-t]' }));
  const dlg = await screen.findByRole('dialog', { name: 'Open session “(untitled)”?' });
  offline();
  await userEvent.click(within(dlg).getByRole('button', { name: 'Switch' }));
  expect(switches()).toEqual([]);
  expect(screen.getByRole('status')).toHaveTextContent('Could not switch: no connection to the server…');
});

it('a failed /sessions load says so in one short line, never an HTML body', async () => {
  setup();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html><body><h1>Internal</h1>' + 'x'.repeat(500) + '</body></html>', { status: 500 })));
  await userEvent.click(btn());
  expect(await screen.findByText('Could not load sessions: HTTP 500')).toBeInTheDocument();
  expect(brief(500, 'y'.repeat(300))).toHaveLength(120);
  expect(brief(500, '  cannot\n list   sessions ')).toBe('cannot list sessions');
});

it('formatting: ago as in the prototype', () => {
  setLang('ru');
  expect(ago(NOW - 20_000, NOW)).toBe('только что');
  expect(ago(NOW - 59 * 60_000, NOW)).toBe('59 мин назад');
  expect(ago(NOW - 90 * 60_000, NOW)).toBe('2 ч назад');
  setLang('en');
  expect(ago(NOW - 3 * 86400_000, NOW)).toBe(new Date(NOW - 3 * 86400_000).toLocaleDateString('en', { day: 'numeric', month: 'short' }));
});

describe('rename', () => {
  const pencil = (title: string) => screen.getByRole('button', { name: `Rename: ${title}` });
  const posted = () => vi.mocked(fetch).mock.calls.filter(([u]) => u === '/sessions/rename');
  const answer = (r: Response) => vi.mocked(fetch).mockImplementation(async (url) => {
    if (url === '/sessions') return new Response(JSON.stringify(view));
    if (url === '/sessions/rename') return r;
    return new Response('[]');
  });

  it('Enter saves: the row shows the new title and no switch is asked for', async () => {
    const { switches } = setup();
    answer(new Response('ok'));
    await openPicker();
    await userEvent.click(pencil('older here'));
    const box = screen.getByRole('textbox', { name: 'Rename' });
    expect(box).toHaveValue('older here');
    await userEvent.clear(box);
    await userEvent.type(box, 'better{Enter}');
    expect(await screen.findByText('better')).toBeInTheDocument();
    expect(JSON.parse(posted()[0]![1]!.body as string)).toEqual({ id: E, title: 'better' });
    expect(switches()).toEqual([]);
    expect(screen.queryByRole('dialog', { name: /Open/ })).toBeNull();
  });

  it('the running session and an untitled one can be renamed too', async () => {
    setup();
    await openPicker();
    expect(pencil('current talk')).toBeEnabled();
    await userEvent.click(pencil('(untitled)'));
    expect(screen.getByRole('textbox', { name: 'Rename' })).toHaveValue('');
  });

  it('Esc cancels the edit and leaves the menu open; nothing is sent', async () => {
    setup();
    await openPicker();
    await waitFor(() => expect(screen.getByPlaceholderText('Search by title…')).toHaveFocus()); // it moves there a frame later
    await userEvent.click(pencil('older here'));
    await userEvent.keyboard('x{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Rename' })).toBeNull();
    expect(screen.getByText('older here')).toBeInTheDocument();
    expect(menu()).toBeInTheDocument();
    expect(posted()).toEqual([]);
  });

  it('a refusal says so and keeps what was typed', async () => {
    setup();
    answer(new Response('no such session', { status: 500 }));
    await openPicker();
    await userEvent.click(pencil('older here'));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Rename' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Rename' }), 'better{Enter}');
    expect(await screen.findByRole('status')).toHaveTextContent('Could not rename the session: no such session');
    expect(screen.getByRole('textbox', { name: 'Rename' })).toHaveValue('better');
  });
});

describe('menuItems', () => {
  it('only this project\'s sessions not archived, filtered by title; the archived ones of this project apart', () => {
    const v: SessionsView = { ...VIEW, sessions: VIEW.sessions.map((x) => (x.id === B || x.id === C ? { ...x, archived: true } : x)) };
    const m = menuItems(v, '');
    expect(m.items.map((x) => x.id)).toEqual([A, E]);
    expect(m.archived.map((x) => x.id)).toEqual([C]);
    expect(menuItems(VIEW, 'here').items.map((x) => x.id)).toEqual([E]);
    expect(menuItems(VIEW, '/tmp').items).toEqual([]);
  });

  it('the open session stays in the list even when archived (it was opened from the archive)', () => {
    const v: SessionsView = { ...VIEW, sessions: VIEW.sessions.map((x) => (x.id === A ? { ...x, archived: true } : x)) };
    const m = menuItems(v, '');
    expect(m.items.map((x) => x.id)).toEqual([A, C, E]);
    expect(m.archived).toEqual([]);
  });
});

describe('archive and delete', () => {
  const posts = (u: string) => vi.mocked(fetch).mock.calls.filter(([url]) => url === u).map(([, init]) => JSON.parse(String(init!.body)));
  const answer = (fail?: string) => vi.mocked(fetch).mockImplementation(async (url) => {
    if (url === '/sessions') return new Response(JSON.stringify(view));
    if (url === '/sessions/archive' || url === '/sessions/delete') return new Response(fail ?? 'ok', { status: fail ? 500 : 200 });
    return new Response('[]');
  });
  const withDelete = (emit: ReturnType<typeof setup>['emit'], on = true) =>
    emit({ kind: 'hello', protocol: 5, capabilities: { compact: true, clear: true, modes: ['default'], usage: true, fileSuggestions: true, fork: true, idleCompact: true, models: true, ...(on ? { deleteSession: true } : {}) } });

  it('Archive hides a row; "Show archive (N)" lists it with Restore, which brings it back', async () => {
    setup();
    answer();
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Archive: (untitled)' }));
    expect(posts('/sessions/archive')).toEqual([{ id: C, archived: true }]);
    await waitFor(() => expect(rows()).toEqual(['+ new session in this project', 'current talk', 'older here']));
    await userEvent.click(screen.getByRole('button', { name: 'Show archive (1)' }));
    const row = within(menu()).getByText('(untitled)').closest('[data-sess-archived]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Restore: (untitled)' }));
    expect(posts('/sessions/archive')).toEqual([{ id: C, archived: true }, { id: C, archived: false }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Show archive|Hide archive/ })).toBeNull());
    expect(rows()).toContain('(untitled)');
  });

  it('the open session offers neither archive nor delete', async () => {
    const { emit } = setup();
    withDelete(emit);
    await openPicker();
    expect(screen.queryByRole('button', { name: 'Archive: current talk' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete: current talk' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Archive: (untitled)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete: (untitled)' })).toBeInTheDocument();
  });

  it('no delete without the capability (omp)', async () => {
    const { emit } = setup();
    withDelete(emit, false);
    await openPicker();
    expect(screen.getByRole('button', { name: 'Archive: (untitled)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('delete asks first: cancel sends nothing, confirm deletes and the row is gone', async () => {
    const { emit } = setup();
    withDelete(emit);
    answer();
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Delete: (untitled)' }));
    let dlg = await screen.findByRole('dialog', { name: 'Delete session “(untitled)”?' });
    expect(dlg).toHaveTextContent('cannot be undone');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(posts('/sessions/delete')).toEqual([]);
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Delete: (untitled)' }));
    dlg = await screen.findByRole('dialog', { name: 'Delete session “(untitled)”?' });
    view = { ...VIEW, sessions: VIEW.sessions.filter((x) => x.id !== C) };
    await userEvent.click(within(dlg).getByRole('button', { name: 'Delete' }));
    expect(posts('/sessions/delete')).toEqual([{ id: C }]);
    await screen.findByText('current talk'); // the menu opens again, without it
    expect(screen.queryByText('(untitled)', { selector: '[data-t]' })).toBeNull();
  });

  it('a delete from the archive list comes back to the archive list, filter kept', async () => {
    const { emit } = setup();
    withDelete(emit);
    view = { ...VIEW, sessions: VIEW.sessions.map((x) => (x.id === C || x.id === E ? { ...x, archived: true } : x)) };
    answer();
    await openPicker();
    await userEvent.type(screen.getByPlaceholderText('Search by title…'), 'e');
    await userEvent.click(screen.getByRole('button', { name: 'Show archive (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete: older here' }));
    view = { ...view, sessions: view.sessions.filter((x) => x.id !== E) };
    await userEvent.click(within(await screen.findByRole('dialog', { name: /Delete session/ })).getByRole('button', { name: 'Delete' }));
    await screen.findByText('current talk');
    expect(screen.getByPlaceholderText('Search by title…')).toHaveValue('e');
    expect(screen.queryByText('older here')).toBeNull();
  });

  it('a delete answered while the agent works does not reopen the menu', async () => {
    const { emit } = setup();
    withDelete(emit);
    answer();
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Delete: (untitled)' }));
    const dlg = await screen.findByRole('dialog', { name: /Delete session/ });
    emit({ kind: 'user', id: 'u1', text: 'from another window', ts: 1 });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts('/sessions/delete')).toEqual([{ id: C }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull();
  });

  it('a delete answered 404 (gone already) drops the row without a failure note', async () => {
    const { emit } = setup();
    withDelete(emit);
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (url === '/sessions') return new Response(JSON.stringify(view));
      if (url === '/sessions/delete') return new Response('no such session', { status: 404 });
      return new Response('[]');
    });
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Delete: (untitled)' }));
    view = { ...VIEW, sessions: VIEW.sessions.filter((x) => x.id !== C) };
    await userEvent.click(within(await screen.findByRole('dialog', { name: /Delete session/ })).getByRole('button', { name: 'Delete' }));
    await screen.findByText('current talk');
    expect(screen.queryByText('(untitled)', { selector: '[data-t]' })).toBeNull();
    expect(screen.queryByText(/Could not delete/)).toBeNull();
  });

  it('a refused archive or delete says so', async () => {
    const { emit } = setup();
    withDelete(emit);
    answer('no such session');
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Archive: (untitled)' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not archive the session: no such session');
    expect(rows()).toContain('(untitled)');
    await userEvent.click(screen.getByRole('button', { name: 'Delete: (untitled)' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: /Delete session/ })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not delete the session: no such session'));
  });
});
