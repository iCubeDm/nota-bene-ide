import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CLAUDE_CAPABILITIES } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import type { ExportJob } from './api.ts';
import { ExportControl } from './ExportControl.tsx';

const EDIT = 'cuts/demo.nbcut.json';
let job: ExportJob | null;
let ffmpeg: boolean;
let old: string | null;
let posts: { url: string; body: unknown }[];
let refuse: { status: number; error: string; detail: string } | null;

beforeEach(() => {
  setLang('en');
  posts = [];
  job = null;
  ffmpeg = true;
  old = null;
  refuse = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { path: string; mode: ExportJob['mode'] };
      posts.push({ url, body });
      if (url === '/cut/export') {
        if (refuse) return Response.json({ error: refuse.error, detail: refuse.detail }, { status: refuse.status });
        job = { edit: body.path, mode: body.mode, phase: 'running', progress: 0, output: `exports/demo.${body.mode}` };
        return Response.json({ job }, { status: 202 });
      }
      if (url === '/cut/export/cancel') {
        job = { ...job!, phase: 'cancelled' };
        return Response.json({ ok: true });
      }
    }
    if (url === `/cut/export?path=${encodeURIComponent(EDIT)}`) return Response.json({ ffmpeg, ...(old && { ffmpegProblem: 'old', ffmpegVersion: old }), job });
    return new Response('not found', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(capability: boolean | undefined = true) {
  const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
  store.dispatch({ type: 'server/event', payload: { kind: 'hello', protocol: 21, capabilities: { ...CLAUDE_CAPABILITIES, ...(capability === undefined ? {} : { ffmpeg: capability }) } } });
  render(<Provider store={store}><ExportControl path={EDIT} pollMs={20} /></Provider>);
  return store;
}

it('exports in the chosen format, shows the progress, and the result opens as a tab', async () => {
  const store = setup();
  fireEvent.change(screen.getByRole('combobox', { name: 'Export format' }), { target: { value: 'wav' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(posts).toEqual([{ url: '/cut/export', body: { path: EDIT, mode: 'wav' } }]));
  job = { ...job!, progress: 0.42 };
  expect(await screen.findByText('Exporting… 42%')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  job = { ...job, phase: 'done', progress: 1 };
  fireEvent.click(await screen.findByRole('button', { name: 'exports/demo.wav' }));
  expect(store.getState().tabs.active).toBe('file:exports/demo.wav');
});

it('Cancel stops the running export', async () => {
  job = { edit: EDIT, mode: 'mp4', phase: 'running', progress: 0.1, output: 'exports/demo.mp4' };
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(posts).toEqual([{ url: '/cut/export/cancel', body: { path: EDIT } }]));
  expect(await screen.findByText('Export cancelled')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});

it('a failure shows ffmpeg\'s last lines; a refusal is worded', async () => {
  job = { edit: EDIT, mode: 'mp4', phase: 'failed', progress: 0.3, output: 'exports/demo.mp4', error: 'line a\nError: boom' };
  setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: line a Error: boom');
  refuse = { status: 422, error: 'missing-source', detail: 'media/gone.mp4' };
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Source file not found: media/gone.mp4'));
});

it('without ffmpeg: no Export, the way to install it instead', async () => {
  ffmpeg = false;
  setup(false);
  expect(await screen.findByText(/Export needs ffmpeg on this computer/)).toBeInTheDocument();
  expect(screen.getByText('brew install ffmpeg')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
});

it('ffmpeg installed after the server started: the live answer wins over hello', async () => {
  setup(false);
  expect(await screen.findByRole('button', { name: 'Export' })).toBeEnabled();
});

it('a server without the export routes asks for a restart', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  setup(undefined);
  expect(await screen.findByText('This server cannot export yet: restart the server')).toBeInTheDocument();
});

it('an invalid edit refused by the server says so in words', async () => {
  setup();
  refuse = { status: 422, error: 'invalid-edit', detail: 'clips[0].out: out-before-in' };
  const button = await screen.findByRole('button', { name: 'Export' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: The edit has problems: fix them, then export again (clips[0].out: out-before-in)');
});


it('too old an ffmpeg: no Export, the version needed and the one found', async () => {
  ffmpeg = false;
  old = '4.3.1';
  setup(false);
  expect(await screen.findByText('Export needs ffmpeg 4.4 or newer; this computer has 4.3.1. Update it, then export again:')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
});

it('every refusal is worded, an unexpected server failure too', async () => {
  setup();
  const button = await screen.findByRole('button', { name: 'Export' });
  await waitFor(() => expect(button).toBeEnabled());
  const cases: [number, string, string, string][] = [
    [422, 'unreadable-source', 'media/x.mp4', 'ffmpeg cannot read the source file: media/x.mp4'],
    [400, 'not-an-edit', 'a.txt', 'Not an edit file: a.txt'],
    [422, 'empty', '', 'The edit has no clips: there is nothing to export'],
    [422, 'bad-edit', 'Unexpected token', 'The edit file is damaged (Unexpected token)'],
    [404, 'no-edit', '', 'The edit file is gone'],
    [503, 'closing', '', 'The server is shutting down'],
    [409, 'output-busy', 'exports/demo.mp4', 'Another edit is exporting to exports/demo.mp4 now'],
    [500, 'internal', 'disk on fire', 'The server could not export: disk on fire'],
  ];
  for (const [status, error, detail, text] of cases) {
    refuse = { status, error, detail };
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`Export failed: ${text}`));
  }
});
