#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.md from the lockfile and node_modules (issue 468): the license texts of everything the web
// build may bundle (web's production dependencies, transitively) and the list of the runtime dependencies npm installs
// beside the package. `npm test` fails while the file differs from what this generates.
//
//   npm run gen:notices
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const NOTICES = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** The lockfile entries of `roots` and everything they depend on (dependencies, optional ones), outside our workspaces. */
function closure(lock, workspace) {
  const found = new Map();
  const resolve = (from, name) => {
    for (let dir = from; ; dir = dir.includes('/node_modules/') ? dir.slice(0, dir.lastIndexOf('/node_modules/')) : '') {
      const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
      if (lock.packages[key]) return key;
      if (!dir) return null;
    }
  };
  const visit = (key) => {
    const e = lock.packages[key];
    if (found.has(key) || e.link) return;
    found.set(key, e);
    for (const name of Object.keys({ ...e.dependencies, ...e.optionalDependencies })) {
      const dep = resolve(key, name);
      if (dep) visit(dep);
    }
  };
  for (const name of Object.keys(lock.packages[workspace].dependencies ?? {})) {
    if (name.startsWith('@nota-bene/')) continue;
    const key = resolve(workspace, name);
    if (key) visit(key);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // not localeCompare: the order must not depend on ICU
  return [...found].map(([key, e]) => ({ key, name: key.slice(key.lastIndexOf('node_modules/') + 13), version: e.version, license: e.license ?? ownJson(key).license ?? 'UNKNOWN' }))
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
}

/** The installed package's own package.json ({} when it is not installed). */
function ownJson(key) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, key, 'package.json'), 'utf8')); } catch { return {}; }
}

/** The standard MIT text for a package that says MIT but ships no license file, with its author from its package.json. */
function mitText(key) {
  const a = ownJson(key).author;
  const author = typeof a === 'string' ? a : a?.name;
  if (!author) throw new Error(`${key}: MIT without a license file or an author`);
  return `MIT License

Copyright (c) ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

/** The license and notice files a package ships, joined; '' when it ships none. */
function licenseText(key) {
  const dir = path.join(ROOT, key);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort(); } catch { /* not installed */ }
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n');
}

export function notices() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const web = closure(lock, 'web');
  const runtime = closure(lock, 'server');
  // one block per distinct license text: most MIT texts differ only in their copyright line, so they stay apart
  const byText = new Map();
  for (const p of web) {
    let text = licenseText(p.key);
    if (!text && p.license === 'MIT') text = mitText(p.key);
    else if (!text) throw new Error(`${p.name} ${p.version}: ${p.license} and no license file`);
    // a package that names no license anywhere (khroma) but ships the MIT text
    if (p.license === 'UNKNOWN' && /^(The )?MIT License\b/.test(text)) p.license = 'MIT';
    if (p.license === 'UNKNOWN') throw new Error(`${p.name} ${p.version}: no license named`);
    byText.set(text, [...(byText.get(text) ?? []), p]);
  }
  const out = [
    '# Third-party notices',
    '',
    '<!-- Generated by scripts/third-party-notices.mjs from package-lock.json; do not edit by hand. -->',
    '',
    'Nota Bene itself is Apache-2.0 (LICENSE). The web app (web/dist) bundles the libraries below, among them the fonts',
    'Inter and Geist Mono (SIL Open Font License 1.1), which are served from this package; the page never fetches them from',
    'another host.',
    '',
    '## Runtime dependencies',
    '',
    'npm installs these beside the package (a platform\'s own package only on that platform), each with its own license files:',
    '',
    ...runtime.map((p) => `- ${p.name} ${p.version}: ${p.license}`),
    '',
    '## Bundled in the web app',
    '',
  ];
  for (const [text, ps] of byText) {
    out.push(`### ${ps.map((p) => `${p.name} ${p.version}`).join(', ')}`, '', `License: ${[...new Set(ps.map((p) => p.license))].join(', ')}`, '', '````', text, '````', '');
  }
  return out.join('\n');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  fs.writeFileSync(NOTICES, notices());
  console.log(`wrote ${path.relative(ROOT, NOTICES)}`);
}
