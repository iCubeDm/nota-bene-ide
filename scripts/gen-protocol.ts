// npm run gen:protocol: write the protocol's generated files; with --check, fail when one is stale or missing.
import fs from 'node:fs';
import path from 'node:path';
import { check, generate } from './protocol/gen.ts';

const root = new URL('../', import.meta.url).pathname;
const files = generate();
if (process.argv.includes('--check')) {
  const stale = check(files, root);
  for (const p of stale) console.error(`stale: ${p}`);
  if (stale.length) {
    console.error('run: npm run gen:protocol');
    process.exit(1);
  }
} else {
  for (const [p, text] of files) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
}
