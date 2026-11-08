import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setUpdateCheckPref } from './prefs.ts';
import { CHECK_EVERY_MS, changelog, changesSince, isNewer, latestKnown, updateCheck } from './update.ts';

const npm = (version: unknown) => vi.fn(async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch;

describe('isNewer', () => {
  it.each([
    ['1.2.1', '1.2.0', true],
    ['1.10.0', '1.9.9', true],
    ['2.0.0', '1.9.9', true],
    ['1.2.0', '1.2.0', false],
    ['1.2.0', '1.2.1', false],
  ])('%s over %s: %s', (a, b, want) => { expect(isNewer(a, b)).toBe(want); });
});

describe('updateCheck', () => {
  // Every check gets its own file: the default one is the machine's real state folder.
  const dirs: string[] = [];
  const tmpFile = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-update-'));
    dirs.push(d);
    return path.join(d, 'update-check.json');
  };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const mk = () => ({ off: () => false, file: tmpFile() });
  let on = mk();
  beforeEach(() => { on = mk(); });

  it('says the newer version, and nothing when this one is the latest or ahead', async () => {
    expect(await updateCheck({ ...on, fetch: npm('1.3.0') })('1.2.0')).toBe('1.3.0');
    expect(await updateCheck({ ...on, file: tmpFile(), fetch: npm('1.2.0') })('1.2.0')).toBeNull();
    expect(await updateCheck({ ...on, file: tmpFile(), fetch: npm('1.2.0') })('1.3.0')).toBeNull();
  });

  it('a source checkout and the off switch never ask', async () => {
    const f = npm('9.0.0');
    expect(await updateCheck({ ...on, fetch: f })('v1.2.0-5-gabcdef')).toBeNull();
    expect(await updateCheck({ file: on.file, fetch: f, off: () => true })('1.2.0')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('the switch in Settings stops the asking at once, and turning it back on resumes it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-update-'));
    vi.stubEnv('NOTA_BENE_HOME', home);
    vi.stubEnv('NOTA_BENE_NO_UPDATE_CHECK', '');
    const f = npm('1.3.0');
    const check = updateCheck({ fetch: f, file: on.file });
    setUpdateCheckPref(false);
    expect(await check('1.2.0')).toBeNull();
    expect(f).not.toHaveBeenCalled();
    setUpdateCheckPref(true);
    expect(await check('1.2.0')).toBe('1.3.0');
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true });
  });

  it('asks npm once a minute, however many windows ask', async () => {
    const f = npm('1.3.0');
    let t = 0;
    const check = updateCheck({ ...on, fetch: f, now: () => t });
    await Promise.all([check('1.2.0'), check('1.2.0')]);
    t = CHECK_EVERY_MS - 1;
    await check('1.2.0');
    expect(f).toHaveBeenCalledTimes(1);
    t = CHECK_EVERY_MS;
    await check('1.2.0');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('two checkers on one file ask npm once a minute', async () => {
    const f = npm('1.7.0');
    let t = 0;
    const a = updateCheck({ ...on, fetch: f, now: () => t });
    const b = updateCheck({ ...on, fetch: f, now: () => t });
    expect(await a('1.6.0')).toBe('1.7.0');
    expect(await b('1.6.0')).toBe('1.7.0');
    t = 50_000;
    expect(await a('1.6.0')).toBe('1.7.0');
    expect(await b('1.6.0')).toBe('1.7.0');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('asks again after a minute', async () => {
    const f = npm('1.7.0');
    let t = 0;
    const check = updateCheck({ ...on, fetch: f, now: () => t });
    await check('1.6.0');
    t = 60_000;
    await check('1.6.0');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a broken file counts as stale', async () => {
    fs.writeFileSync(on.file, 'not json');
    const f = npm('1.7.0');
    expect(await updateCheck({ ...on, fetch: f, now: () => 0 })('1.6.0')).toBe('1.7.0');
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(on.file, 'utf8'))).toEqual({ latest: '1.7.0', at: 0 });
    expect(fs.statSync(on.file).mode & 0o777).toBe(0o600);
  });

  it('off asks nothing and reads nothing', async () => {
    const f = npm('1.7.0');
    expect(await updateCheck({ file: on.file, fetch: f, off: () => true })('1.6.0')).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(fs.existsSync(on.file)).toBe(false);
  });

  it('latestKnown reads the file without asking', async () => {
    expect(latestKnown({ file: on.file })).toBeNull();
    await updateCheck({ ...on, fetch: npm('1.7.0'), now: () => 0 })('1.6.0');
    expect(latestKnown({ file: on.file })).toBe('1.7.0');
    fs.writeFileSync(on.file, 'not json');
    expect(latestKnown({ file: on.file })).toBeNull();
  });

  it('no network, an error page or a strange answer keep what was known', async () => {
    let t = 0;
    let answer: () => Promise<Response> = async () => new Response(JSON.stringify({ version: '1.3.0' }));
    const check = updateCheck({ ...on, fetch: (async () => answer()) as typeof fetch, now: () => t });
    expect(await check('1.2.0')).toBe('1.3.0');
    for (const next of [
      async () => { throw new Error('offline'); },
      async () => new Response('nope', { status: 503 }),
      async () => new Response(JSON.stringify({ version: '<b>' })),
      async () => new Response('not json'),
    ]) {
      answer = next;
      t += CHECK_EVERY_MS;
      expect(await check('1.2.0')).toBe('1.3.0');
    }
  });
});

const LOG = `# Changelog

## Unreleased

- not out yet

## 1.4.0 — 2026-12-01

- Themes.

## 1.3.1 — 2026-11-20

- A fix.

## 1.3.0 — 2026-11-02

- The update notice.
`;

describe('changesSince', () => {
  it('the sections newer than the running version, newest first, without Unreleased', () => {
    expect(changesSince(LOG, '1.3.0')).toBe('## 1.4.0 — 2026-12-01\n\n- Themes.\n\n## 1.3.1 — 2026-11-20\n\n- A fix.');
    expect(changesSince(LOG, '1.3.1')).toBe('## 1.4.0 — 2026-12-01\n\n- Themes.');
  });

  it('nothing newer, or no sections at all: empty', () => {
    expect(changesSince(LOG, '1.4.0')).toBe('');
    expect(changesSince('just text', '1.0.0')).toBe('');
  });
});

describe('changelog', () => {
  const raw = (body: string) => vi.fn(async () => new Response(body)) as unknown as typeof fetch;

  it("reads CHANGELOG.md at the newer version's tag, once per version", async () => {
    const f = raw(LOG);
    const read = changelog({ fetch: f });
    expect(await read('1.3.0', '1.4.0')).toContain('- A fix.');
    await read('1.3.1', '1.4.0');
    expect(f).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f).mock.calls[0]![0]).toBe('https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/v1.4.0/CHANGELOG.md');
    expect(await read('1.3.1', '1.4.0')).toBe('## 1.4.0 — 2026-12-01\n\n- Themes.');
  });

  it('no network or an error page: null, and the next ask tries again', async () => {
    let answer: () => Promise<Response> = async () => { throw new Error('offline'); };
    const read = changelog({ fetch: (async () => answer()) as typeof fetch });
    expect(await read('1.3.0', '1.4.0')).toBeNull();
    answer = async () => new Response('nope', { status: 404 });
    expect(await read('1.3.0', '1.4.0')).toBeNull();
    answer = async () => new Response(LOG);
    expect(await read('1.3.0', '1.4.0')).toContain('Themes');
  });

  it('a version that is not a release is never asked for', async () => {
    const f = raw(LOG);
    expect(await changelog({ fetch: f })('1.3.0', '../main')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
