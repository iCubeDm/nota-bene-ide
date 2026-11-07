import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setUpdateCheckPref } from './prefs.ts';
import { changelog, changesSince, isNewer, updateCheck } from './update.ts';

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
  const on = { off: () => false };

  it('says the newer version, and nothing when this one is the latest or ahead', async () => {
    expect(await updateCheck({ ...on, fetch: npm('1.3.0') })('1.2.0')).toBe('1.3.0');
    expect(await updateCheck({ ...on, fetch: npm('1.2.0') })('1.2.0')).toBeNull();
    expect(await updateCheck({ ...on, fetch: npm('1.2.0') })('1.3.0')).toBeNull();
  });

  it('a source checkout and the off switch never ask', async () => {
    const f = npm('9.0.0');
    expect(await updateCheck({ ...on, fetch: f })('v1.2.0-5-gabcdef')).toBeNull();
    expect(await updateCheck({ fetch: f, off: () => true })('1.2.0')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('the switch in Settings stops the asking at once, and turning it back on resumes it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-update-'));
    vi.stubEnv('NOTA_BENE_HOME', home);
    vi.stubEnv('NOTA_BENE_NO_UPDATE_CHECK', '');
    const f = npm('1.3.0');
    const check = updateCheck({ fetch: f });
    setUpdateCheckPref(false);
    expect(await check('1.2.0')).toBeNull();
    expect(f).not.toHaveBeenCalled();
    setUpdateCheckPref(true);
    expect(await check('1.2.0')).toBe('1.3.0');
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true });
  });

  it('asks npm once in 6 hours, however many windows ask', async () => {
    const f = npm('1.3.0');
    let t = 0;
    const check = updateCheck({ ...on, fetch: f, now: () => t });
    await Promise.all([check('1.2.0'), check('1.2.0')]);
    t = 6 * 3600_000 - 1;
    await check('1.2.0');
    expect(f).toHaveBeenCalledTimes(1);
    t = 6 * 3600_000;
    await check('1.2.0');
    expect(f).toHaveBeenCalledTimes(2);
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
      t += 6 * 3600_000;
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
