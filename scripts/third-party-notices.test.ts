import fs from 'node:fs';
import { expect, it } from 'vitest';
import { NOTICES, notices } from './third-party-notices.mjs';

it('THIRD-PARTY-NOTICES.md is what the lockfile says (else run npm run gen:notices)', () => {
  const text = notices();
  expect(text).toContain('### @fontsource/inter 5.3.0');
  expect(text).toMatch(/### [^\n]*\breact 19\./);
  expect(text).toContain('- ws ');
  expect(fs.readFileSync(NOTICES, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
});
