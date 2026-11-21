// The frame's DOM and focus order (issue 511): the header, the strips, the panels, the footer and the overlays are
// slot contributions now, and their `order` values reproduce the order the frame had when it imported them.
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { events, renderWith, stubRoutes } from '@/testing';
import { App } from '@/App.tsx';

let restore = () => {};
beforeEach(() => { setLang('en'); localStorage.clear(); restore = stubRoutes({}).restore; });
afterEach(() => { cleanup(); restore(); });

// every landmark, named control and field, in document order
const outline = (root: ParentNode) =>
  [...root.querySelectorAll('header, nav, footer, aside, [id], [data-strip], [data-center], [data-git-slot], [data-proj-block], button, input, textarea, [role="menuitem"]')]
    .filter((e) => e.tagName !== 'linearGradient') // ids from useId, which follow the tree's shape
    .map((e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (e.getAttribute('aria-label') ? `[${e.getAttribute('aria-label')}]` : ''));

it('the frame keeps its order', async () => {
  const { container } = renderWith(<App />, { hello: {}, events: [events.session()] });
  await act(async () => {});
  expect(outline(container)).toMatchInlineSnapshot(`
    [
      "header",
      "svg#logo[Nota Bene]",
      "div",
      "button",
      "b#proj",
      "span#root-path",
      "button#copy-root[Copy path]",
      "div",
      "span#conn",
      "button#restartBtn[Restart the agent]",
      "button#restartMenuBtn[Restart menu]",
      "span#session",
      "button#settingsBtn[Settings]",
      "button#stopWindowBtn[Stop Nota Bene]",
      "nav[Open projects]",
      "button[Open folder…]",
      "nav[Left tool windows]",
      "button#toggleTree[Files]",
      "aside#tree-sheet",
      "button[Select opened file]",
      "button[Expand all]",
      "button[Collapse all]",
      "button[Refresh]",
      "input[Filter files…]",
      "div",
      "button#sessBtn[Sessions]",
      "button[All tabs]",
      "div#items",
      "footer",
      "button[Prompt history]",
      "textarea#composer-input",
      "button[Voice message]",
      "button[Send]",
      "button[Stop the agent]",
      "input",
      "button[Enter — send
    Shift+Enter — new line
    Ctrl+Enter — interrupt the agent and send (asks first)]",
      "button[Attach a file (paste: Ctrl+V)]",
      "button[Compact context (/compact)]",
      "button[Clear context (/clear)]",
      "aside#comments",
      "span#cTitle",
      "button#cClose[Hide panel]",
      "div#cards",
      "button#cSend",
      "nav[Right tool windows]",
      "button#toggleComments[Comments]",
    ]
  `);
});

it('the settings menu keeps its rows in order', async () => {
  renderWith(<App />, { hello: {}, events: [events.session()] });
  await act(async () => {});
  fireEvent.keyDown(screen.getByRole('button', { name: 'Settings' }), { key: 'Enter' });
  expect(outline(screen.getByRole('menu'))).toMatchInlineSnapshot(`
    [
      "div#langMenu",
      "div#themeMenu",
      "button#scaleDown[Smaller]",
      "span#scaleValue",
      "button#scaleUp[Larger]",
      "div#remoteMenu",
      "div#usageMenu",
      "div#allSettings",
    ]
  `);
});
