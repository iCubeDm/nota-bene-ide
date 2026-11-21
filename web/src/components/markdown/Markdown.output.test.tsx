import { render, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { expect, it, vi } from 'vitest';
import { makeStore } from '@/testing';
import { Markdown } from '@/components/markdown/Markdown.tsx';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg data-test="m"></svg>' })) },
}));

// issue 545: the code blocks and the media player come from the plugins' registrations; what a reply renders to stays
// byte for byte what it was when Markdown drew them itself. The player's own markup is the media plugin's: only that a
// bar stands over the video is Markdown's
it('a reply with a diagram, an svg, a video and plain code renders as before', async () => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const text = [
    'Intro with `code` and #ff8980.',
    '```mermaid\ngraph TD; A-->B\n```',
    '```svg\n<svg viewBox="0 0 2 2"><rect width="1" height="1"/></svg>\n```',
    '![clip](media/a.mp4)',
    '```js\nconst a = 1;\n```',
  ].join('\n\n');
  const { container } = render(<Provider store={store}><Markdown text={text} final /></Provider>);
  await waitFor(() => expect(container.querySelector('.mermaid-out svg[data-test="m"]')).not.toBeNull());
  const bar = container.querySelector('.md-media [data-player-bar]');
  expect(bar).not.toBeNull();
  bar!.replaceChildren();
  bar!.removeAttribute('class');
  bar!.removeAttribute('style');
  expect(container.innerHTML).toMatchSnapshot();
});
