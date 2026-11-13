import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { SessionNotFoundError } from './agent/types.ts';
import { EventHub } from './hub.ts';
import { archiveRoute, cwdOf, deleteRoute, listSessionsView, renameRoute, titleOf } from './sessions.ts';
import { wirePath } from './wirePath.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sessions-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const jsonl = (project: string, id: string, body: string) => {
  fs.mkdirSync(path.join(dir, project), { recursive: true });
  fs.writeFileSync(path.join(dir, project, `${id}.jsonl`), body);
};

describe('listSessionsView cwd', () => {
  it('normalises every cwd with the native realpath, keeping the raw value when it does not exist', async () => {
    const real = fs.realpathSync.native(dir);
    const link = path.join(real, 'link');
    fs.symlinkSync(real, link);
    const backend = {
      listSessions: async () => [
        { sessionId: 'a', cwd: link, lastModified: 1, fileSize: 1 },
        { sessionId: 'b', cwd: '/nb-no-such-dir/x', lastModified: 2, fileSize: 1 },
      ],
    } as never;
    const view = await listSessionsView({ backend, current: null, root: real, projectsDir: dir });
    // in the wire form: `C:/...` on Windows, the path itself on POSIX
    expect(view.sessions.map((s) => s.cwd)).toEqual([wirePath(real), '/nb-no-such-dir/x']);
    expect(view.root).toBe(wirePath(real));
  });
});

describe('titleOf', () => {
  it('skips a slash command and returns the summary', () => {
    expect(titleOf({ customTitle: '/clear', summary: 'Fix the parser', firstPrompt: 'hi' })).toBe('Fix the parser');
    expect(titleOf({ summary: '/clear', firstPrompt: 'first' })).toBe('first');
  });

  it('prefers the custom title, and gives null when nothing is usable', () => {
    expect(titleOf({ customTitle: 'Mine', summary: 's' })).toBe('Mine');
    expect(titleOf({ customTitle: '', summary: '', firstPrompt: '/compact' })).toBeNull();
    expect(titleOf(null)).toBeNull();
  });
});

describe('cwdOf', () => {
  it('finds the cwd deep in a large head', () => {
    const pad = `${JSON.stringify({ type: 'x', pad: 'p'.repeat(200 * 1024) })}\n`;
    jsonl('-a-b', 'id-big', `${pad}{"type":"user","cwd":"/work/\\"q\\" dir"}\n`);
    expect(cwdOf('id-big', dir)).toBe('/work/"q" dir');
  });

  it('gives null past the first 256 KB', () => {
    const pad = `${JSON.stringify({ pad: 'p'.repeat(300 * 1024) })}\n`;
    jsonl('-a', 'id-far', `${pad}{"cwd":"/late"}\n`);
    expect(cwdOf('id-far', dir)).toBeNull();
  });

  it('caches a miss', () => {
    expect(cwdOf('id-later', dir)).toBeNull();
    jsonl('-x', 'id-later', '{"cwd":"/now"}\n');
    expect(cwdOf('id-later', dir)).toBeNull();
  });

  it('forgets a miss after 60 s, keeps a hit', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(cwdOf('id-ttl', dir)).toBeNull();
      jsonl('-t', 'id-ttl', '{"cwd":"/first"}\n');
      vi.setSystemTime(Date.now() + 59_000);
      expect(cwdOf('id-ttl', dir)).toBeNull();
      vi.setSystemTime(Date.now() + 2_000);
      expect(cwdOf('id-ttl', dir)).toBe('/first');
      fs.writeFileSync(path.join(dir, '-t', 'id-ttl.jsonl'), '{"cwd":"/second"}\n');
      vi.setSystemTime(Date.now() + 120_000);
      expect(cwdOf('id-ttl', dir)).toBe('/first');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an id that is not a plain file name', () => {
    expect(cwdOf('../etc', dir)).toBeNull();
  });
});

describe('listSessionsView', () => {
  it('drops entries without a cwd, falling back to the transcript', async () => {
    jsonl('-p', 'from-file', '{"cwd":"/from/file"}\n');
    // cwds that exist nowhere, so they come back as given: a real one would be realpathed (`/a` is `D:\a` on a CI runner)
    const backend = {
      listSessions: async () => [
        { sessionId: 'with-cwd', summary: 'A', lastModified: 10, fileSize: 100, cwd: '/nb-a' },
        { sessionId: 'from-file', firstPrompt: 'B', lastModified: 20, fileSize: 200 },
        { sessionId: 'no-cwd', summary: 'C', lastModified: 30, fileSize: 300 },
        { sessionId: 'slash', summary: '/clear', lastModified: 40, fileSize: 400, cwd: '/nb-d' },
      ],
    };
    const view = await listSessionsView({ backend, current: 'with-cwd', root: '/nb-a', projectsDir: dir });
    expect(view).toEqual({
      current: 'with-cwd',
      root: '/nb-a',
      sessions: [
        { id: 'with-cwd', title: 'A', at: 10, size: 100, cwd: '/nb-a' },
        { id: 'from-file', title: 'B', at: 20, size: 200, cwd: '/from/file' },
        { id: 'slash', title: '', at: 40, size: 400, cwd: '/nb-d' },
      ],
    });
  });

  it('marks the archived ones; an archived id the listing does not have is ignored', async () => {
    const backend = {
      listSessions: async () => [
        { sessionId: 'kept', lastModified: 1, cwd: '/nb-a' },
        { sessionId: 'hidden', lastModified: 2, cwd: '/nb-a' },
      ],
    };
    const view = await listSessionsView({ backend, current: null, root: '/nb-a', archived: new Set(['hidden', 'gone']) });
    expect(view.sessions.map((s) => [s.id, s.archived])).toEqual([['kept', undefined], ['hidden', true]]);
  });
});

describe('POST /sessions/rename', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const call = async (rename: (id: string, title: string) => Promise<void>, body: string, method = 'POST') => {
    const server = http.createServer(renameRoute({ hub: new EventHub(), rename }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/`, { method, ...(method === 'POST' ? { body } : {}) });
    server.close();
    return res.status;
  };

  it('passes a trimmed title on', async () => {
    const rename = vi.fn(async () => {});
    expect(await call(rename, JSON.stringify({ id: ID, title: '  a name ' }))).toBe(200);
    expect(rename).toHaveBeenCalledWith(ID, 'a name');
  });

  it.each([
    ['no title', { id: ID }],
    ['an empty title', { id: ID, title: '   ' }],
    ['two lines', { id: ID, title: 'a\nb' }],
    ['a long title', { id: ID, title: 'x'.repeat(201) }],
    ['a bad id', { id: '../x', title: 'a' }],
  ])('refuses %s', async (_, body) => {
    const rename = vi.fn(async () => {});
    expect(await call(rename, JSON.stringify(body))).toBe(400);
    expect(rename).not.toHaveBeenCalled();
  });

  it('refuses a GET, and says 500 when the agent refuses', async () => {
    expect(await call(async () => {}, '', 'GET')).toBe(405);
    expect(await call(async () => { throw new Error('no'); }, JSON.stringify({ id: ID, title: 'a' }))).toBe(500);
  });
});

const ID = '11111111-1111-4111-8111-111111111111';
const OPEN = '22222222-2222-4222-8222-222222222222';
const post = async (route: http.RequestListener, body: string, method = 'POST') => {
  const server = http.createServer(route);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/`, { method, ...(method === 'POST' ? { body } : {}) });
  server.close();
  return { status: res.status, text: await res.text() };
};

describe('POST /sessions/archive', () => {
  const route = (set: (id: string, on: boolean) => void) => archiveRoute({ hub: new EventHub(), current: () => OPEN, set });

  it('archives and restores another session', async () => {
    const set = vi.fn();
    expect((await post(route(set), JSON.stringify({ id: ID, archived: true }))).status).toBe(200);
    expect((await post(route(set), JSON.stringify({ id: ID, archived: false }))).status).toBe(200);
    expect(set.mock.calls).toEqual([[ID, true], [ID, false]]);
  });

  it('refuses to archive the open session (restoring it is fine)', async () => {
    const set = vi.fn();
    expect((await post(route(set), JSON.stringify({ id: OPEN, archived: true }))).status).toBe(409);
    expect(set).not.toHaveBeenCalled();
    expect((await post(route(set), JSON.stringify({ id: OPEN, archived: false }))).status).toBe(200);
  });

  it.each([
    ['a bad id', { id: '../x', archived: true }],
    ['no flag', { id: ID }],
  ])('refuses %s', async (_, body) => {
    const set = vi.fn();
    expect((await post(route(set), JSON.stringify(body))).status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it('refuses a GET and bad json', async () => {
    expect((await post(route(vi.fn()), '', 'GET')).status).toBe(405);
    expect((await post(route(vi.fn()), '{')).status).toBe(400);
  });
});

describe('POST /sessions/delete', () => {
  const route = (o: { remove?: (id: string) => Promise<void>; switching?: boolean; forget?: (id: string) => void; elsewhere?: string; hub?: EventHub }) =>
    deleteRoute({
      hub: o.hub ?? new EventHub(), current: () => OPEN, switching: () => o.switching ?? false, openElsewhere: async (id) => id === o.elsewhere,
      remove: o.remove, forget: o.forget ?? (() => {}),
    });

  it('deletes another session through the agent, then forgets Nota Bene\'s own data of it', async () => {
    const remove = vi.fn(async () => {});
    const forget = vi.fn();
    expect((await post(route({ remove, forget }), JSON.stringify({ id: ID }))).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(ID);
    expect(forget).toHaveBeenCalledWith(ID);
  });

  it('is a 404 for an agent that cannot delete', async () => {
    expect((await post(route({}), JSON.stringify({ id: ID }))).status).toBe(404);
  });

  it('refuses the open session, any while a switch runs, and one another live window has open', async () => {
    const remove = vi.fn(async () => {});
    expect((await post(route({ remove }), JSON.stringify({ id: OPEN }))).status).toBe(409);
    expect((await post(route({ remove, switching: true }), JSON.stringify({ id: ID }))).status).toBe(409);
    expect(await post(route({ remove, elsewhere: ID }), JSON.stringify({ id: ID }))).toEqual({ status: 409, text: 'the session is open in another window' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('a session the agent no longer has is a 404, not a server error; its own data goes all the same', async () => {
    const hub = new EventHub();
    const emit = vi.spyOn(hub, 'emit');
    const forget = vi.fn();
    const r = await post(route({ hub, remove: async () => { throw new SessionNotFoundError('Session x not found'); }, forget }), JSON.stringify({ id: ID }));
    expect(r.status).toBe(404);
    expect(forget).toHaveBeenCalledWith(ID);
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses a bad id; says 500 with the agent\'s words when it refuses, and keeps its own data', async () => {
    const remove = vi.fn(async () => {});
    expect((await post(route({ remove }), JSON.stringify({ id: '../x' }))).status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
    const forget = vi.fn();
    expect(await post(route({ remove: async () => { throw new Error('disk busy'); }, forget }), JSON.stringify({ id: ID }))).toEqual({ status: 500, text: 'disk busy' });
    expect(forget).not.toHaveBeenCalled();
  });
});
