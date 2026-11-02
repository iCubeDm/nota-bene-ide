import { describe, expect, it, vi } from 'vitest';
import { isNewer, updateCheck } from './update.ts';

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
