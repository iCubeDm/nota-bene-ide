import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { TranscriptTooLargeError } from '../agent/types.ts';
import { readHistory } from './history.ts';

const ev: ServerEvent = { kind: 'user', id: 'u1', text: 'hi', ts: 0 };

function run(history: () => Promise<ServerEvent[]>, timeoutMs = 50) {
  const errors: [string, string][] = [];
  const p = readHistory({ read: history, timeoutMs, report: (w, e) => errors.push([w, (e as Error).message]) });
  return { p, errors };
}

describe('readHistory', () => {
  it('the transcript replay', async () => {
    const { p, errors } = run(async () => [ev]);
    expect(await p).toEqual([ev]);
    expect(errors).toEqual([]);
  });

  it('an unreadable transcript: an empty feed, reported as history', async () => {
    const { p, errors } = run(async () => { throw new Error('bad'); });
    expect(await p).toEqual([]);
    expect(errors).toEqual([['history', 'bad']]);
  });

  it('a transcript too large to replay: an empty feed, reported as history-too-large for the page to translate', async () => {
    const { p, errors } = run(async () => { throw new TranscriptTooLargeError(2 ** 31); });
    expect(await p).toEqual([]);
    expect(errors).toEqual([['history-too-large', 'the transcript is 2048 MiB, too large to replay; the agent resumes it as usual']]);
  });

  it('a read that hangs: an empty feed after the timeout, reported as switch; a late rejection is no news', async () => {
    let reject!: (e: Error) => void;
    const { p, errors } = run(() => new Promise((_, r) => { reject = r; }), 20);
    expect(await p).toEqual([]);
    expect(errors).toEqual([['switch', 'transcript read timed out']]);
    reject(new Error('late'));
    await new Promise((r) => setTimeout(r, 5));
    expect(errors).toHaveLength(1);
  });
});
