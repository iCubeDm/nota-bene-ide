import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@/core/store/feed.ts';
import { clockTime, dayLabel, dayStarts, fullTime } from './time.ts';

// local times, so the tests hold in any time zone
const now = new Date(2026, 10, 16, 15, 0).getTime();
const at = (d: number, h = 9, m = 5, y = 2026, mo = 10) => new Date(y, mo, d, h, m).getTime();

describe('clockTime', () => {
  it('only the time today; the date too on another day; the year too in another year', () => {
    expect(clockTime(at(16, 9, 5), 'en', now)).toBe('09:05 AM');
    expect(clockTime(at(16, 9, 5), 'ru', now)).toBe('09:05');
    expect(clockTime(at(15, 21, 40), 'en', now)).toBe('Nov 15, 09:40 PM');
    expect(clockTime(at(15, 21, 40), 'ru', now)).toBe('15 нояб., 21:40');
    expect(clockTime(at(3, 8, 0, 2025, 0), 'en', now)).toBe('Jan 3, 2025, 08:00 AM');
  });
});

describe('fullTime', () => {
  it('the whole date and time, in the language', () => {
    expect(fullTime(at(15, 21, 40), 'en')).toMatch(/^Sunday, November 15, 2026.*09:40:00 PM$/);
    expect(fullTime(at(15, 21, 40), 'de')).toMatch(/Sonntag, 15\. November 2026.*21:40:00/);
  });
});

describe('dayLabel', () => {
  it('Today, Yesterday, else the date: with the year only when it is not this one', () => {
    expect(dayLabel(at(16), 'en', now)).toBe('Today');
    expect(dayLabel(at(15, 23, 59), 'en', now)).toBe('Yesterday');
    expect(dayLabel(at(16), 'ru', now)).toBe('Сегодня');
    expect(dayLabel(at(15), 'ru', now)).toBe('Вчера');
    expect(dayLabel(at(14), 'en', now)).toBe('Saturday, November 14');
    expect(dayLabel(at(14), 'ru', now)).toBe('Суббота, 14 ноября'); // a sentence start: capitalised
    expect(dayLabel(at(31, 12, 0, 2025, 11), 'en', now)).toBe('Wednesday, December 31, 2025');
  });

  it('yesterday across a month boundary', () => {
    expect(dayLabel(at(31, 10, 0, 2026, 9), 'en', at(1))).toBe('Yesterday');
  });
});

describe('dayStarts', () => {
  const user = (id: string, ts: number): FeedItem => ({ kind: 'user', id, text: id, ts });
  const reply = (id: string, ts: number): FeedItem => ({ kind: 'assistant', id, text: id, final: true, ts });
  const tool = (id: string): FeedItem => ({ kind: 'tool', id, name: 'Bash', arg: '', sub: false, input: {} });

  it('marks the first dated item and each one whose day differs from the last dated one', () => {
    const items = [user('u0', 0), user('u1', at(14, 10)), reply('a1', at(14, 11)), tool('t1'), reply('a2', 0), user('u2', at(16, 8)), reply('a3', at(16, 9))];
    expect([...dayStarts(items)]).toEqual([[1, at(14, 10)], [5, at(16, 8)]]);
  });

  it('a skipped item never starts a day; the next dated one does', () => {
    const items = [user('u1', at(14)), user('u2', at(16)), reply('a', at(16))];
    expect([...dayStarts(items, new Set(['u2']))]).toEqual([[0, at(14)], [2, at(16)]]);
  });

  it('nothing dated: no separators', () => {
    expect(dayStarts([user('u', 0), tool('t')]).size).toBe(0);
  });
});
