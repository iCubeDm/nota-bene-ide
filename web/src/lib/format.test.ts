import { afterAll, expect, it } from 'vitest';
import { getLang, setLang, type Lang } from '@/i18n/index.ts';
import { byteSize, compact, money, num, percent } from './format.ts';

const first = getLang();
afterAll(() => setLang(first));
const inLang = <T,>(l: Lang, f: () => T): T => (setLang(l), f());

it('one formatter, in the UI language (issue 469)', () => {
  // ICU spaces are no-break ones; compared as plain spaces
  const all = (l: Lang) => inLang(l, () => JSON.parse(JSON.stringify({
    compact: [999, 1500, 45_678, 2.5e6, 3.2e9].map(compact),
    num: num(1234567),
    money: money(123, 'USD'),
    percent: percent(1 / 3),
    bytes: [512, 2048, 1.5e6, 2e9].map(byteSize),
  }).replace(/\s/g, ' ')));
  expect(all('en')).toEqual({ compact: ['999', '1.5K', '45.7K', '2.5M', '3.2B'], num: '1,234,567', money: '$1.23', percent: '33%', bytes: ['512 byte', '2 kB', '1.5 MB', '2 GB'] });
  expect(all('ru')).toEqual({ compact: ['999', '1,5 тыс.', '45,7 тыс.', '2,5 млн', '3,2 млрд'], num: '1 234 567', money: '1,23 $', percent: '33 %', bytes: ['512 Б', '2 кБ', '1,5 МБ', '2 ГБ'] });
  expect(all('zh-CN')).toEqual({ compact: ['999', '1500', '4.57万', '250万', '32亿'], num: '1,234,567', money: 'US$1.23', percent: '33%', bytes: ['512 B', '2 kB', '1.5 MB', '2 GB'] });
  // a language switch takes effect at once; German has no short unit for thousands, so every digit, grouped
  expect(inLang('de', () => compact(45_678))).toBe('45.678');
});
