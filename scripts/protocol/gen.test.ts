import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DART_PATH } from './dart.ts';
import { check, generate } from './gen.ts';
import { mobileStrings } from './mobileStrings.ts';
import { SCHEMA_PATH } from './schema.ts';
import { ALL_MODES } from '../../shared/src/protocol.ts';
import { ru } from '../../web/src/i18n/ru.ts';

function writeAll(files: Map<string, string>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-gen-'));
  for (const [p, text] of files) {
    fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
    fs.writeFileSync(path.join(tmp, p), text);
  }
  return tmp;
}

// building the schema compiles protocol.ts: seconds on a loaded CI runner
it('check passes on fresh output', () => {
  const files = generate();
  expect(check(files, writeAll(files))).toEqual([]);
}, 60_000);

it('check names a stale file', () => {
  const files = generate();
  const tmp = writeAll(files);
  fs.appendFileSync(path.join(tmp, SCHEMA_PATH), ' ');
  expect(check(files, tmp)).toEqual([SCHEMA_PATH]);
  fs.rmSync(path.join(tmp, SCHEMA_PATH));
  expect(check(files, tmp)).toEqual([SCHEMA_PATH]);
  fs.appendFileSync(path.join(tmp, DART_PATH), ' ');
  expect(check(files, tmp)).toEqual([SCHEMA_PATH, DART_PATH]);
}, 60_000);

it('the mobile strings carry the web keys through webString', () => {
  const out = mobileStrings();
  expect(out).toContain('String webString(String key, String lang)');
  expect(out).toContain(`"h5": {`);
  expect(out).toContain(`"week": {`);
  expect(out).toContain(JSON.stringify(ru.week));
});

it('the mobile strings carry the mode and clear texts of every provider', () => {
  const out = mobileStrings();
  expect(out).toContain(JSON.stringify(ru.mode_plan));
  for (const id of ALL_MODES) expect(out).toContain(`"mode_${id}_desc": {`);
  for (const k of ['modeTip', 'clearTitle', 'clearQ', 'clearBtn', 'compactTip', 'clearTip']) expect(out).toContain(`"${k}": {`);
});

it('the mobile strings carry the source names of an action and a subagent, with their bare forms', () => {
  const out = mobileStrings();
  for (const k of ['srcTool', 'srcToolBare', 'srcAgentReply', 'srcAgentReplyBare', 'srcAgentTool', 'srcAgentToolBare']) expect(out).toContain(`"${k}": {`);
  expect(out).toContain(JSON.stringify(ru.srcAgentReply('')));
});
