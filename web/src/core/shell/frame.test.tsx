// The frame's DOM and focus order (issue 511): the header, the strips, the panels, the footer and the overlays are
// slot contributions now, and their `order` values reproduce the order the frame had when it imported them. The
// fixture shows every part that can show: a repository, a running task with its drawer, an update, a pending
// compaction, a model, remote access online and the folder starter.
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteState } from '@nota-bene/shared';
import { setLang } from '@/core/i18n/index.ts';
import { events, renderWith, stubRoutes } from '@/core/testing';
import { openStarter } from '@/plugins/projects/api.ts';
import { App } from '@/App.tsx';
import { Slots } from './Slots.tsx';

const REMOTE: RemoteState = {
  configured: true, enabled: true, running: true, online: true, relay: 'wss://relay.example.com', hostFingerprint: 'abcd', devices: [],
  pairing: null, legacy: false, lastError: null, startFailed: false, accessKey: false, hosts: [],
};

let restore = () => {};
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  restore = stubRoutes({
    '/git-status': { branch: 'main', detached: false, dirty: false },
    '/vcs-branches': [],
    '/sources': [{ id: 'here', kind: 'checkout', label: 'main', ref: 'main', dir: '/project' }],
    '/system/update': { current: '1.2.0', latest: '1.3.0', phase: 'available', canUpdate: false, auto: false, busy: false, log: '/state/update.log' },
  }).restore;
});
afterEach(() => { cleanup(); restore(); });

// every landmark, named control, field, highlight layer and live region, in document order (portals included)
const outline = (root: ParentNode) =>
  [...root.querySelectorAll('header, nav, footer, aside, [id], [data-strip], [data-center], [data-git-slot], [data-proj-block], [data-hl-layer], [data-tasks-drawer], [role="status"], [role="dialog"], button, input, textarea, [role="menuitem"]')]
    .filter((e) => e.tagName !== 'linearGradient' && !e.id.startsWith('radix-')) // ids from useId, which follow the tree's shape
    .map((e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (e.getAttribute('aria-label') ? `[${e.getAttribute('aria-label')}]` : '')
      + (e.hasAttribute('data-hl-layer') ? '[hl]' : '') + (e.hasAttribute('data-tasks-drawer') ? '[drawer]' : ''));

async function frame() {
  const r = renderWith(<App />, {
    hello: {},
    events: [
      events.session({ model: 'claude-test' }),
      { kind: 'remote', state: REMOTE },
      { kind: 'compact-pending', pending: true, held: [] },
      events.agent({ t: 'task', phase: 'started', id: 't1', desc: 'a task', type: 'local_bash' }),
    ],
  });
  await act(async () => {});
  await act(async () => {});
  return r;
}

it('the frame keeps its order', async () => {
  await frame();
  fireEvent.click(document.getElementById('tasks-indicator')!);
  expect(outline(document.body)).toMatchInlineSnapshot(`
    [
      "header",
      "svg#logo[Nota Bene]",
      "div",
      "button",
      "b#proj",
      "span#root-path",
      "button#copy-root[Copy path]",
      "div",
      "button#git-branch",
      "span#conn",
      "button#updateBtn",
      "button#compactPendingChip",
      "button#restartBtn[Restart the agent]",
      "button#restartMenuBtn[Restart menu]",
      "button[claude-test · Model and effort]",
      "span#session",
      "button#settingsBtn[Settings]",
      "span#settingsDot",
      "button#stopWindowBtn[Stop Nota Bene]",
      "nav[Open projects]",
      "button[Open folder…]",
      "nav[Left tool windows]",
      "button#toggleTree[Files]",
      "button#toggleChanges[Changes]",
      "button#toggleLog[Git log]",
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
      "div[hl]",
      "div#tasks-drawer[Tasks][drawer]",
      "button",
      "button",
      "footer",
      "button#tasks-indicator[Background tasks]",
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
      "div",
    ]
  `);
});

it('the left panels keep their order with Changes open', async () => {
  await frame();
  fireEvent.click(document.getElementById('toggleChanges')!);
  await act(async () => {});
  expect(outline(document.querySelector('[data-center]')!.parentElement!)).toMatchInlineSnapshot(`
    [
      "nav[Open projects]",
      "button[Open folder…]",
      "nav[Left tool windows]",
      "button#toggleTree[Files]",
      "button#toggleChanges[Changes]",
      "button#toggleLog[Git log]",
      "aside#tree-sheet",
      "button[Select opened file]",
      "button[Expand all]",
      "button[Collapse all]",
      "button[Refresh]",
      "input[Filter files…]",
      "aside#changes-sheet",
      "button[Refresh]",
      "div",
      "button#sessBtn[Sessions]",
      "button[Close]",
      "button[All tabs]",
      "div#items",
      "div[hl]",
      "button",
      "button",
      "div[hl]",
      "footer",
      "button#tasks-indicator[Background tasks]",
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

it('the overlays keep their order with the starter open', async () => {
  await frame();
  act(() => openStarter('open'));
  await act(async () => {});
  expect(outline(document.body).slice(-12)).toMatchInlineSnapshot(`
    [
      "button#cClose[Hide panel]",
      "div#cards",
      "button#cSend",
      "nav[Right tool windows]",
      "button#toggleComments[Comments]",
      "div",
      "nav[Path]",
      "input[Folder path (Tab completes)]",
      "nav[Places]",
      "input",
      "button",
      "button",
    ]
  `);
});

it('the settings menu keeps its rows in order', async () => {
  await frame();
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

it('a plugin\'s part at an order the frame takes is an error', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderWith(<Slots at="header.end" own={[{ order: 10, render: () => null }]} />)).toThrow('the slot "header.end" has a plugin\'s part at the frame\'s order 10');
  vi.restoreAllMocks();
});
