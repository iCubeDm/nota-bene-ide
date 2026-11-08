// npm run mobile:assets: copies what the phone app bundles from the web's dependencies (the same mermaid as the
// desktop) into mobile/app/assets/. The copies are git-ignored; CI runs this before building the APK.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'web', 'package.json'));
const src = path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js');
const dest = path.join(root, 'mobile', 'app', 'assets', 'mermaid', 'mermaid.min.js');
fs.copyFileSync(src, dest);
console.log(`copied ${path.relative(root, src)} → ${path.relative(root, dest)}`);
