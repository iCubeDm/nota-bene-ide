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
let posts: { url: string; body: unknown }[];
let refuse: { status: number; error: string; detail: string } | null;

beforeEach(() => {
  setLang('en');
  posts = [];
  job = null;
  ffmpeg = true;
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
    if (url === `/cut/export?path=${encodeURIComponent(EDIT)}`) return Response.json({ ffmpeg, job });
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

