import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { check, generate } from './gen.ts';
import { SCHEMA_PATH } from './schema.ts';

function writeAll(files: Map<string, string>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gen-'));
  for (const [p, text] of files) {
    fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
    fs.writeFileSync(path.join(tmp, p), text);
  }
  return tmp;
}

it('check passes on fresh output', () => {
  const files = generate();
  expect(check(files, writeAll(files))).toEqual([]);
});

it('check names a stale file', () => {
  const files = generate();
  const tmp = writeAll(files);
  fs.appendFileSync(path.join(tmp, SCHEMA_PATH), ' ');
  expect(check(files, tmp)).toEqual([SCHEMA_PATH]);
  fs.rmSync(path.join(tmp, SCHEMA_PATH));
  expect(check(files, tmp)).toEqual([SCHEMA_PATH]);
});
