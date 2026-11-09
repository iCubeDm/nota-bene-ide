// The phone formats usage numbers with its own port (mobile/app/lib/usage/format.dart): this writes and checks what the
// desktop's formatters give for fixed values in every app language, which the app's usage_format_test compares with its
// own. UPDATE_FIXTURES=1 rewrites the JSON after a deliberate change of either side.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { getLang, setLang, type Lang } from '@/i18n/index.ts';
import { fmtTokens, modelName, money, num, part, pct } from './UsageView.tsx';

const LANGS: [string, Lang][] = [['en', 'en'], ['ru', 'ru'], ['zh', 'zh-CN'], ['es', 'es'], ['pt', 'pt-BR'], ['de', 'de']];
const PAIRS: [number, number][] = [[1, 3], [1, 2], [0, 5], [5, 0], [7, 7], [1, 1000], [2, 3]];
const TOKENS = [0, 999, 1500, 2.5e6, 3.2e9];
const CURRENCIES = ['EUR', 'GBP', 'CAD', 'AUD', 'CNY'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5.5'];
const first = getLang();

afterAll(() => setLang(first));

it('the desktop side of the usage formatter fixtures', () => {
  const data = Object.fromEntries(LANGS.map(([app, web]) => {
    setLang(web);
    return [app, {
      pct: PAIRS.map(([a, b]) => pct(a, b)),
      part: PAIRS.filter(([, b]) => b > 0).map(([a, b]) => part(a, b)),
      fmtTokens: TOKENS.map((n) => fmtTokens(n)),
      modelName: MODELS.map(modelName),
      num: num(1234567),
      money: [money(12345, 'USD'), money(500, 'JPY')],
      currencies: CURRENCIES.map((c) => money(12345, c)),
    }];
  }));
  const out = path.resolve(__dirname, '../../../mobile/app/test/fixtures/usage/format.json');
  const json = JSON.stringify({ pairs: PAIRS, tokens: TOKENS, models: MODELS, currencies: CURRENCIES, langs: data }, null, 1) + '\n';
  if (process.env.UPDATE_FIXTURES) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
  }
  expect(json).toBe(fs.readFileSync(out, 'utf8'));
});
