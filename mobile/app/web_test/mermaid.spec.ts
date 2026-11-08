import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const page = pathToFileURL(path.join(root, 'mobile/app/assets/mermaid/render.html')).href;

/** Every ```mermaid block of the project's docs: the diagrams its agents actually write. */
function diagrams(): { where: string; source: string }[] {
  const files = ['docs/architecture.md', ...['docs/superpowers/specs', 'docs/superpowers/plans'].flatMap((d) =>
    fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.md')).map((f) => `${d}/${f}`))];
  return files.flatMap((f) => [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(/```mermaid\n([\s\S]*?)```/g)]
    .map((m, i) => ({ where: `${f} #${i + 1}`, source: m[1]! })));
}

type Out = { png?: string; w?: number; h?: number; error?: string };

test('the project\'s diagrams render to images, dark and light', async ({ page: p }) => {
  await p.goto(page);
  const all = diagrams();
  expect(all.length).toBeGreaterThan(5);
  for (const d of all) {
    for (const dark of [true, false]) {
      const out = await p.evaluate(([s, k]) => (window as unknown as { render: (...a: unknown[]) => Promise<Out> }).render('t', s, k, 2), [d.source, dark] as const);
      expect(out.error, `${d.where} (${dark ? 'dark' : 'light'})`).toBeUndefined();
      expect(out.png).toMatch(/^data:image\/png;base64,/);
      expect(out.png!.length, d.where).toBeGreaterThan(1000);
    }
  }
});

test('a broken diagram comes back as an error line', async ({ page: p }) => {
  await p.goto(page);
  const out = await p.evaluate(() => (window as unknown as { render: (...a: unknown[]) => Promise<Out> }).render('t', 'flowchart LR\n  A --> ((', true, 2));
  expect(out.png).toBeUndefined();
  expect(out.error).toBeTruthy();
  expect(out.error).not.toContain('\n');
});
