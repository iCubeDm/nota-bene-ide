// The phone builds its anchors from its own Markdown rendering (mobile/app/lib/comments/anchor.dart): this writes and
// checks the desktop's rendered text of the shared fixtures, which the app's anchor_test compares with its own.
// UPDATE_FIXTURES=1 rewrites the .txt files after a deliberate change of either renderer.
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { textOf } from '@/anchors/text.ts';
import { Markdown } from '@/feed/Markdown.tsx';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg><text>A</text></svg>' })) },
}));

afterEach(cleanup);

const dir = path.resolve(__dirname, '../../../mobile/app/test/fixtures/md');
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

it('has the fixtures', () => expect(names.length).toBeGreaterThanOrEqual(5));

for (const name of names) {
  it(`the rendered text of ${name}`, async () => {
    const md = fs.readFileSync(path.join(dir, name), 'utf8');
    // as TextBody shows a Markdown file
    const { container } = render(<div className="nb-card nb-prose"><Markdown text={md} final src="here" /></div>);
    await new Promise((r) => setTimeout(r, 50)); // a mermaid block renders after a tick; its SVG labels are text here, the phone skips the picture
    const text = textOf(container);
    const out = path.join(dir, name.replace(/\.md$/, '.txt'));
    if (process.env.UPDATE_FIXTURES) fs.writeFileSync(out, text);
    expect(text).toBe(fs.readFileSync(out, 'utf8'));
  });
}
