import fs from 'node:fs';
import path from 'node:path';
import { DART_PATH, schemaToDart } from './dart.ts';
import { mobileStrings, STRINGS_PATH } from './mobileStrings.ts';
import { buildSchema, SCHEMA_PATH, serialize } from './schema.ts';

/** repo-relative path -> the file's text */
export function generate(): Map<string, string> {
  const schema = buildSchema();
  return new Map([[SCHEMA_PATH, serialize(schema)], [DART_PATH, schemaToDart(schema)], [STRINGS_PATH, mobileStrings()]]);
}

/** the paths whose file under `root` is missing or differs from `files` */
export function check(files: Map<string, string>, root: string): string[] {
  const stale: string[] = [];
  for (const [p, text] of files) {
    let have: string | null = null;
    try { have = fs.readFileSync(path.join(root, p), 'utf8'); } catch { /* missing */ }
    if (have !== text) stale.push(p);
  }
  return stale;
}
