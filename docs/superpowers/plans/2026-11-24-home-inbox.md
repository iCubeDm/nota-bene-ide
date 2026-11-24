# Home page inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server's home page (`/`) keeps the app's frame and shows a Projects tree on the left and an Inbox in the
centre. The Inbox answers an agent's open requests in place.

**Architecture:** Each agent's `/info` lists its open requests (`asks`), and the projects list passes them through for
this server's rows. `POST /a/<id>/permission` answers one through the same `answer` call as the socket. On the web, the
frame becomes one `Frame` component shared by the agent page and the home page. A slot part says where it shows
(`on: 'home' | 'both'`, absent: agent pages only). The chat's permission card moves to the core and takes its answer as
a prop.

**Tech Stack:** Node server (TypeScript run directly), React + Redux Toolkit, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-home-inbox-design.md`

## Global Constraints

- Every new or changed user-visible string goes through `web/src/core/i18n` with a real translation in all of `LANGS`:
  en, ru, de, es, pt-BR, zh-CN.
- Plugins import only `@/sdk` and `@/sdk/ui` (`scripts/boundaries.test.ts`).
- Neutral fixtures only (public repo). Tests use ports 4790–4795 or port 0.
- The home page never opens an agent's socket. An answer goes through `SessionManager.answer` and is audited as the
  socket's `permission` message is.
- A control with a shortcut names it in its tooltip (`withKey`).
- Run test suites as `rtk test <cmd>`. Run the full suite only under the lock
  (`until mkdir /tmp/nb-fullsuite.lock …`).

## Review Focus

- An ask settled between the poll and the click (another tab answered, the agent withdrew it): the route says 409, the
  page reloads the list and the card goes away. No error toast beyond "already answered".
- A Write ask whose `input.content` is megabytes: `/info` is polled every 3 s, so `asks` carries a clipped copy
  (each string value at most 2000 characters). The answer uses only the id.
- A waiting row of another server (another port), or of another computer, has no `asks`: it shows "Open agent" and no
  answer buttons.
- An agent plugin's part (the composer, the model pill, the file tree) must not render on the home page, where the
  store has no agent and no socket.
- Two open asks of one agent show as two cards under that agent, oldest first, and each answers its own id.

---

### Task 1: The server lists and answers open asks

**Files:**
- Modify: `server/src/session/permissions.ts` (the broker)
- Modify: `server/src/session.ts:434,474` (`answer` returns its result; `asks()`)
- Modify: `server/src/server.ts` (the agent's routes: `/permission`; `info()`: `asks`)
- Modify: `server/src/audit.ts` only if `client()` needs no change (it does not: pass the parsed message)
- Modify: `server/src/projects.ts` (`ProbedInfo.asks`, `RunningRow.asks`, passed for `port === own.port` rows only)
- Test: `server/src/session/permissions.test.ts`, `server/src/server.test.ts`, `server/src/projects.test.ts`

**Interfaces:**
- Produces: `type OpenAsk = { id: string; toolName: string; input: Record<string, unknown>; prompt?: Interaction }`,
  exported from `permissions.ts`. Also `PermissionBroker.asks(): OpenAsk[]` (oldest first, both kinds),
  `PermissionBroker.answer(...): boolean` (true when it settled an open ask) and `SessionManager.asks(): OpenAsk[]`.
- Produces: `/info` field `asks?: OpenAsk[]`, absent when none is open, with each string value of `input` clipped to
  2000 characters plus `…`. `RunningRow.asks?: OpenAsk[]`.
- Produces: `POST <agent>/permission`, body `{ id: string; allow: boolean; response?: InteractionAnswer }`. Answers:
  200 `{"ok":true}`; 400 for a body `parseClientMessage` refuses as a `permission`; 405 for any other method; 409
  `already answered` for an unknown or settled id, or an invalid structured response.

- [ ] **Step 1: Write the failing tests**
  - `permissions.test.ts`, `it('lists open asks oldest first, both kinds, and drops a settled one')`: open a plain ask,
    then an `interact` ask. `asks().map(a => a.id)` is `[first, second]`; the second has `prompt`. After `answer(first,
    true)`, which returns `true`, `asks()` holds only the second. `answer(first, true)` again returns `false`.
  - `server.test.ts`, `it('/info lists the open asks; POST /permission answers one; a settled id is 409')`, built like
    the `/info tells pending` test with `ask: { toolName: 'Bash', input: { command: 'ls' } }`:
    - while it waits, `/info`'s `asks` equals `[{ id, toolName: 'Bash', input: { command: 'ls' } }]`;
    - `POST ${s.url}/permission { id, allow: true }` gives 200 and the turn finishes;
    - `asks` is then absent;
    - the same POST again gives 409;
    - `GET /permission` gives 405;
    - `{ id: 1 }` gives 400.
  - `server.test.ts`, `it('/info clips a long input in asks')`: an `ask` with `input: { content: 'x'.repeat(5000) }`.
    `asks[0].input.content.length` is 2001.
  - `projects.test.ts`: in the test that builds rows from probed infos, a probed info with `asks` on the own port keeps
    `asks` on its row. The same on another port gives a row without `asks`.

- [ ] **Step 2: Run them to see them fail**
  Run: `rtk test npx vitest run server/src/session/permissions.test.ts server/src/server.test.ts server/src/projects.test.ts`
  Expected: the new tests FAIL (`asks` is not a function / undefined, 404 on `/permission`).

- [ ] **Step 3: Implement.**
  - The broker keeps one insertion-ordered `Map<string, OpenAsk>`: set on emit, deleted on finish.
  - The route sits beside `/agent/keep`. It reads the body with `readJson` and builds the message with
    `parseClientMessage(JSON.stringify({ ...body, type: 'permission' }))`. Then it writes `audit?.client(msg, 0)` and
    calls `manager.answer`.
  - `info()` adds `...(asks.length ? { asks: asks.map(clipAsk) } : {})`. `clipAsk` lives in `permissions.ts`.

- [ ] **Step 4: Run them to see them pass**
  Same command. Expected: PASS. Then `npx tsc -b`: no errors.

- [ ] **Step 5: Commit** `gh-651: an agent lists its open asks in /info and answers one at POST /permission`

### Task 2: One frame for the agent page and the home page

**Files:**
- Modify: `web/src/core/sdk/registry.ts` (`Slot.on?: 'home' | 'both'`)
- Modify: `web/src/core/shell/Slots.tsx` (export `OnHome` context; filter parts)
- Create: `web/src/core/shell/Frame.tsx` (from `App.tsx`: header, left panels and strip, the centre column with
  `Footer`, right panels and strip, overlays with Toasts)
- Modify: `web/src/App.tsx` (uses `Frame`), `web/src/core/shell/Home.tsx` (`OnHome` = true, `Frame` with
  `<Slots at="home" />`)
- Modify: `web/src/core/shell/Header.tsx`: on the home page, the settings menu has no Usage and no All settings rows
  (they open tabs). Language, theme and scale stay.
- Modify: `web/src/plugins/projects/plugin.ts` (`home` entry gets `on: 'home'`), `web/src/plugins/projects/Starter`'s
  overlay entry gets `on: 'both'`
- Test: `web/src/core/sdk/registry.test.ts`; Create `web/src/core/shell/Home.test.tsx`

**Interfaces:**
- Produces: `Slot.on?: 'home' | 'both'`. On an agent page `Slots` keeps parts whose `on` is absent or `'both'`. On the
  home page it keeps parts whose `on` is `'home'` or `'both'`. The frame's own parts always show.
- Produces: `export const OnHome: React.Context<boolean>` from `core/shell/Slots.tsx`, and
  `export function Frame({ center }: { center: ReactNode }): JSX.Element` from `core/shell/Frame.tsx`.

- [ ] **Step 1: Write the failing tests**
  - `Home.test.tsx`, `it('the home page shows the frame with only the parts that show there')`. Render `<Home/>` with a
    registry from plugins whose parts are a `header.end` part with no `on`, a `strip.left` part with `on: 'home'`, a
    `home` part with `on: 'home'`, and an overlay with `on: 'both'`. Expect a `header` element, the home and overlay
    parts present, the `header.end` part absent, and the `strip.left` part inside `nav[data-strip="left"]`.
  - `it('an agent page leaves out the home parts')`: the same plugins under `<Frame center={null}/>` without `OnHome`.
    The `header.end` and overlay parts are present, the `home` and `strip.left` parts are absent.
  - `registry.test.ts`: the snapshot line for `home` stays `['10 ProjectsHome']` until Task 4 renames it.

- [ ] **Step 2: Run to see them fail**
  Run: `rtk test npx vitest run web/src/core/shell/Home.test.tsx`
  Expected: FAIL (`Frame` / `OnHome` not exported).

- [ ] **Step 3: Implement.** `App` keeps keymap, favicon, sounds, the `blocked` inert wrapper, `OneTab`,
  `LoginRequired` and `Stopped`. The tab strip and panes go into `Frame`'s `center`. `Home` wraps `Frame` in
  `TooltipProvider` and `OnHome.Provider value`. In `Header`, read `useContext(OnHome)` to drop the two rows.

- [ ] **Step 4: Run to see them pass**
  `rtk test npx vitest run web/src/core web/src/plugins/projects` and `npx tsc -b`. Expected: PASS, no type errors.

- [ ] **Step 5: Commit** `gh-651: one frame for the agent page and the home page; a slot part says where it shows`

### Task 3: The permission card in the core, answered through a prop

**Files:**
- Create: `web/src/core/components/PermissionCard.tsx` (moved from `web/src/plugins/feed/PermissionCard.tsx`)
- Modify: `web/src/core/sdk/ui.ts` (export it), `web/src/plugins/feed/items.tsx` (the feed's wrapper),
  remove `web/src/plugins/feed/PermissionCard.tsx` (to `~/.Trash` via `git mv` then delete through git)
- Test: Create `web/src/core/components/PermissionCard.test.tsx`; the feed's existing tests stay green

**Interfaces:**
- Produces: `PermissionCard({ ask, answer, archived, onAnswer }: { ask: { id: string; toolName: string; input:
  Record<string, unknown>; prompt?: Interaction }; answer?: boolean; archived?: boolean; onAnswer(allow: boolean,
  response?: InteractionAnswer): void })`, from `@/sdk/ui`. Its markup and labels are unchanged.

- [ ] **Step 1: Write the failing test** `PermissionCard.test.tsx`:
  - `it('Allow and Deny call onAnswer')` → `onAnswer` called with `(true)` then `(false)`;
  - `it('a prompt's choice calls onAnswer with its id and the fields')` → `onAnswer(true, { choice: 'accept',
    values: { q: 'yes' } })`;
  - `it('an answered ask shows Allowed and no buttons')`.
- [ ] **Step 2: Run to see it fail** `rtk test npx vitest run web/src/core/components/PermissionCard.test.tsx` → FAIL (no module).
- [ ] **Step 3: Move the card.** `dispatch(chat.answer(...))` becomes `onAnswer(...)`. The feed renders
  `<PermissionCard ask={item} answer={item.answer} archived={item.archived} onAnswer={(a, r) => d(chat.answer(item.id, a, r))} />`.
- [ ] **Step 4: Run to see it pass** `rtk test npx vitest run web/src/core/components web/src/plugins/feed scripts/boundaries.test.ts` → PASS.
- [ ] **Step 5: Commit** `gh-651: the permission card moves to the core and answers through a prop`

### Task 4: The home page's projects: title, Home tile, Projects panel, counts

**Files:**
- Modify: `web/src/plugins/projects/api.ts`:
  - mirror `OpenAsk` and `RunningRow.asks?`;
  - add `answerAsk(row: RunningRow, id: string, allow: boolean, response?: InteractionAnswer): Promise<boolean>`;
  - add `panel: boolean` (default true) and `setProjectsPanel` to `projectsSlice`.
- Modify: `web/src/core/sdk/routes.ts`: `agentPermission: (agent: string) => \`/a/${seg(agent)}/permission\``, with
  a doc line saying it is from the home page, whose base is the top.
- Create: `web/src/plugins/projects/HomeParts.tsx`:
  - `HomeTitle` (header.title, `on: 'home'`): "Nota Bene" and `t('homeCounts', projects, agents)`; it sets
    `document.title` with the badge, as `ProjectsHome` does now.
  - `ProjectsToggle` (strip.left order 5, `on: 'home'`).
  - `ProjectsPanel` (panel.left order 20, `on: 'home'`): an aside like the file tree's, with `usePanelWidth('panel:projects:width', 300, 220)`,
    a 40px header `t('projProjects')`, and `ProjectsList home`. Rows start expanded there, so the tree shows agents
    and sessions.
  - `HomeFooter` (footer, `on: 'home'`): `t('homeWorking', n)`, `t('homeWaiting', n)`, `t('homeIdle', n)`.
- Modify: `ProjectRail.tsx`. A Home tile comes first, then a separator. It is current on the home page, and a click
  elsewhere does `nav.go('/')`. Its label is `t('home')`. `projectsPlugin` marks the rail `on: 'both'`.
- Modify: `ProjectSwitcher.tsx` `ProjectsList`: with `home`, `isOpen` is true unless the row was collapsed.
- Modify: i18n, all six languages: `home`, `homeCounts`, `homeWorking`, `homeWaiting`, `homeIdle`, `projPanel`.
- Test: `web/src/plugins/projects/Home.test.tsx` (rewritten), `ProjectRail.test.tsx`

**Interfaces:**
- Consumes: `Slot.on`, `OnHome` (Task 2); `RunningRow.asks` (Task 1's wire shape).
- Produces: `answerAsk` and `projectsSlice.panel` for Task 5.

- [ ] **Step 1: Write the failing tests** (Home.test.tsx fixtures as today: `/system/projects` stubbed)
  - `it('the title counts projects and agents')`: two folders, three agents. The header title shows "Nota Bene" and
    `t('homeCounts', 2, 3)`.
  - `it('the Projects panel lists each project with its agents open, and Recent')`: the agent rows of both folders
    are in the panel.
  - `it('the toggle closes and opens the panel')`.
  - `it('the footer counts working, waiting and idle agents')`.
  - `ProjectRail.test.tsx`, `it('the Home tile is current at the top, and goes home from an agent page')`. Spy on
    `nav.go`: on an agent page a click calls `nav.go('/')`.
- [ ] **Step 2: Run to see them fail** `rtk test npx vitest run web/src/plugins/projects` → FAIL.
- [ ] **Step 3: Implement** as listed; `ProjectsHome` is deleted in Task 5 (the inbox replaces it).
- [ ] **Step 4: Run to see them pass** the same command plus `web/src/core/i18n` → PASS.
- [ ] **Step 5: Commit** `gh-651: the home page's title, Projects panel and counts; a Home tile in the rail`

### Task 5: The Inbox

**Files:**
- Create: `web/src/plugins/projects/Inbox.tsx`. `Inbox` (slot `home` order 10, `on: 'home'`) replaces `ProjectsHome`.
  Delete `Home.tsx` (git rm).
- Modify: `plugin.ts`, i18n (6 languages): `inboxWaiting`, `inboxUnread`, `inboxWorking`, `inboxIdle`, `inboxOpen`,
  `inboxEmpty`, `askGone`.
- Modify: `docs/guide.md` (the home page paragraph), `CHANGELOG.md`.
- Test: `web/src/plugins/projects/Home.test.tsx`; `registry.test.ts` snapshot `home: ['10 Inbox']`

**Interfaces:**
- Consumes: `answerAsk`, `RunningRow.asks`, `enterProject`, `openStarter`, `PermissionCard` (`@/sdk/ui`).

Grouping, one row per agent (`RunningRow`), in this order. Each heading shows its count, and an empty group is hidden:
1. `waiting`: the row's state is `'waiting'`.
2. `unread`: the state is `'idle'` and `unseen > 0`.
3. `working`: the state is `'working'`.
4. `idle`: everything else (`idle` with nothing unseen, `restarting`, `silent`).

Within a group, by folder name. An item shows the tile, the folder, the provider mark and the state's time (`ago(last.at)`).
A click on the item's head calls `enterProject(row)`.
- A waiting row's item shows one `PermissionCard` per `asks` entry, oldest first. Its `onAnswer` calls
  `answerAsk(row, ask.id, …)`. When that returns false (409), it toasts `t('askGone')`. Either way it then reloads the
  list. A waiting row with no `asks` shows `t('inboxOpen')`, a button that does `enterProject(row)`.
- An unread row shows `last.text`, two lines at most.
- A working row shows `title`, or `last.text`.
- With no running rows it shows `t('inboxEmpty')` and the Open folder / New project buttons (`openStarter`).

- [ ] **Step 1: Write the failing tests** (Home.test.tsx):
  - `it('groups agents: waiting, unread, working, idle, each with its count')`. Four rows, one per state, in a shuffled
    order. The `h2` headings read in the order above with "· 1", and an empty group has no heading.
  - `it('answers an ask in place: posts to the agent and reloads')`. A waiting row `{ id: 'claude-k3f7qz', asks:
    [{ id: 'p1', toolName: 'Bash', input: { command: 'ls' } }] }`. Clicking Allow POSTs
    `/a/claude-k3f7qz/permission` with `{ id: 'p1', allow: true }`, and `/system/projects` is fetched again.
  - `it('two asks show as two cards, each answering its own id')`.
  - `it('a settled ask toasts askGone and reloads')`: the stub answers 409.
  - `it('a waiting row with no asks offers Open agent')`: the click posts `/system/projects/enter`.
  - `it('no agents: the empty text and the starter buttons')`.
  - `it('no agent part renders on the home page')`: render the real `PLUGINS` under `<Home/>`. There is no
    `#restartBtn`, no composer `textarea`, and no `#tree-sheet`.
- [ ] **Step 2: Run to see them fail** `rtk test npx vitest run web/src/plugins/projects web/src/core/sdk` → FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run to see them pass.** Run the same command, then `npx tsc -b` and `npm run build -w web`; all
  pass. Then the full suite under the lock: exit 0.
- [ ] **Step 5: Smoke.** On 4790 with a temp `NOTA_BENE_HOME` and two folders, check the home page by screenshot:
  frame, tree, inbox, footer. A fake ask would need a real agent asking, so the answer path rests on the server and
  web tests.
- [ ] **Step 6: Commit** `gh-651: the home page's inbox answers an agent's asks in place`
