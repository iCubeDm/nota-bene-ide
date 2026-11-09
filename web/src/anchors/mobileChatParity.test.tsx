// The phone's chat text (mobile/app/lib/comments/chat_anchor.dart) is the desktop's anchor text of a feed item: this
// writes and checks it for the shared fixtures, which the app's chat_anchor_test compares with its own. A `reply-*.md`
// is an assistant reply, a `user-*.md` what the user sent. UPDATE_FIXTURES=1 rewrites the .txt files.
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { textOf } from '@/anchors/text.ts';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg><text>A</text></svg>' })) },
}));

beforeEach(() => setLang('en'));
afterEach(cleanup);

const dir = path.resolve(__dirname, '../../../mobile/app/test/fixtures/chat');
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

it('has the fixtures', () => expect(names.length).toBeGreaterThanOrEqual(5));

for (const name of names) {
  it(`the anchor text of ${name} in the feed`, () => {
    const md = fs.readFileSync(path.join(dir, name), 'utf8');
    const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
    const user = name.startsWith('user-');
    act(() => {
      void store.dispatch(serverEvent(user
        ? { kind: 'user', id: 'm1', text: md, ts: 0, historic: true }
        : { kind: 'agent', ts: 1, e: { t: 'message', id: 'm1', text: md } }));
    });
    const view = render(<Provider store={store}><Feed /></Provider>);
    const root = view.container.querySelector<HTMLElement>('[data-item-id="m1"]')!;
    const text = textOf(root);
    const out = path.join(dir, name.replace(/\.md$/, '.txt'));
    if (process.env.UPDATE_FIXTURES) fs.writeFileSync(out, text);
    expect(text).toBe(fs.readFileSync(out, 'utf8'));
  });
}
