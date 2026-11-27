# Every client attached, Work here gone (issue 174, PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every socket of a window is attached and live (browser tabs, the phone, another computer's tab); the one-owner rule, its overlay and **Work here** are gone.

**Architecture:** The server drops the owner model: every connection runs today's `oneTab: false` path (attach + handle), with a heartbeat on every socket and the launcher's `open-agent` going to the newest local `go=1` socket only. The web drops the `occupied`/`taken` states, `takeOver`, `?tab=`/`?passive=1` and the overlay; an `occupied` from an older server shows a toast and is never answered.

**Tech Stack:** Node + `ws` (server), React/Redux (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-clients-in-sync-design.md` (§1, §2, §5 PR 1, §8 "Clients", §9 item 1)

## Global Constraints

- Protocol goes 38 → 39 (`PROTOCOL` in `shared/src/protocol.ts`), with no FEATURES entry; run `npm run gen:protocol`.
- `takeover`, `occupied`, `taken-over` and `TAKEN_OVER_CODE` stay in `shared/` in this PR (the phone still uses them; they leave in PR 4). `occupied` is documented as "a server before 39".
- The phone (`mobile/`) is not touched.
- Every user-visible string in all six LANGS (en, ru, de, es, pt-BR, zh-CN); the three strings `occupiedTitle`, `takenTitle`, `workHere` leave the web's LANGS.
- Tests and smoke only on ports 4790–4795, temporary `NOTA_BENE_HOME`, never the user's 4777–4779.
- Branch `gh-174-clients`, every commit subject `gh-174: …`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An old phone app (it still sends `?tab=…&passive=1` after a drop and answers `occupied` with `takeover`) against the new server: it is attached at once and works; a stray `takeover` from it is ignored.
2. A page reloaded while another page is open: no overlay, no grace wait, both get the replay.
3. A socket that stops answering pings (a sleeping laptop): it is terminated, the others stay, and `clients()` drops so a pending restart is not held forever.
4. `nota-bene <folder>` from the terminal while the phone and a local tab show the server: only the newest local `go=1` page moves; the phone never gets `open-agent`.
5. A new page against a server before 39 (`occupied`): one toast, no `takeover` sent, no loop between two such pages.

---

### Task 1: Server: every socket attached

**Files:**
- Modify: `server/src/agent.ts` (WSS section ~460–860, the `Agent` type ~130–140, the returned object ~870–885), `server/src/server.ts` (`ServerOptions` ~85–87, `showIn` ~440–450), `server/src/hub.ts:237` (nothing sends `occupied`/`taken-over` now: both leave the stamp list), `server/src/audit.ts:161`, `shared/src/protocol.ts` (`PROTOCOL = 39`, doc comments), `shared/src/features.ts` (the `agentEvents` comment: one tab per window until 38), `mobile/protocol/lib/src/protocol.g.dart` (generated)
- Create: `server/src/clients.test.ts` (replaces `server/src/onetab.test.ts`, deleted)
- Modify tests: drop `oneTab`/`takeoverGraceMs` from every `agentServer`/`launchServer` call (`grep -rlE 'oneTab|takeoverGraceMs' server/src`); `server/src/auth.test.ts:600-645` (the takeover cases become "a second socket with cookie + key is attached"); `server/src/shell.test.ts:348` (the parked socket case: a second socket is attached and sees the shell output); `server/src/remote/device.test.ts:325-340` (the device's second tab is attached without `takeover`)

**Interfaces:**
- Produces: `Agent.shownSince(): number` = the highest attach order among this agent's open `go=1` sockets (0 if none); `Agent.show(id: string): void` sends `{kind:'open-agent', agent:id}` to that socket only. `Agent.owned` is removed. `ServerOptions.oneTab` and `takeoverGraceMs`, `TAKEOVER_GRACE_MS` are removed.

- [ ] **Step 1: Write the failing tests in `server/src/clients.test.ts`** (server on port 0, `insecureNoAuth`, fake backend, as `comments-sync.test.ts` boots it, without `oneTab`)

```ts
it('two sockets both get the replay and every live event; either may send');
it('?tab= and ?passive=1 are ignored: a passive socket with no other is attached');
it('a takeover from a socket is ignored and nobody gets taken-over or code 4001');
it('a socket that answers no ping is terminated; the other stays and clients() counts 1'); // heartbeatMs: 30
it('two answers to one permission reach the agent once; the second socket alone gets server-error {where:"permission"} "already answered"');
it('open-agent goes to the newest go=1 socket only, never to a socket without go=1');
```

Each asserts the observable: replay frames on both sockets; `hub.clients()`; the second socket's `server-error`; `open-agent` frames counted per socket.

- [ ] **Step 2: Run:** `npx vitest run server/src/clients.test.ts` — Expected: FAIL (the second socket gets `occupied`; no `already answered`).

- [ ] **Step 3: Implement in `server/src/agent.ts`**
  - Delete `owner`, `takeover()`, `role`, `ownerGone`, `passive`, `tab`, the grace and the `if (oneTab …)` branches; every connection does `attach(ws)` (today's `attachOwner`) and its messages go to `handle(ws, msg)` (today's `handleOwner`); a parsed `takeover` is dropped without audit.
  - Heartbeat: one `setInterval(…, o.heartbeatMs ?? HEARTBEAT_MS)` over `wss.clients`, a `WeakMap<WebSocket, boolean>` alive flag set on `pong`; a socket whose last ping got no pong is `terminate()`d.
  - Follow: `follows` stays a `WeakSet`; each `go=1` socket gets `since = ++attaches` at attach, kept in a `Map<WebSocket, number>` deleted on close. `shownSince()` = max of the open ones; `show(id)` sends to the socket with that max.
  - `case 'permission'`: `if (!manager.answer(…)) ws.send(server-error {where:'permission', message:'already answered'})` — to that socket only, not through the hub.
  - In `server.ts` remove the `owned()` line from `showIn` and its comment; drop `oneTab`/`takeoverGraceMs` from `ServerOptions`.
  - `PROTOCOL = 39`; doc comments of `takeover`/`occupied`/`taken-over`/`TAKEN_OVER_CODE`: "sent by a server before 39"; `npm run gen:protocol`.

- [ ] **Step 4: Fix the tests that relied on takeover or `oneTab`** (files above); delete `server/src/onetab.test.ts`.

- [ ] **Step 5: Run:** `npx tsc -b && npx vitest run server shared scripts bin` — Expected: PASS.

- [ ] **Step 6: Commit** `gh-174: every socket of a window is attached; no owner, takeover or grace`

### Task 2: Web: no overlay, no takeover

**Files:**
- Delete: `web/src/core/shell/OneTab.tsx`, `web/src/core/shell/OneTab.test.tsx`
- Modify: `web/src/core/sdk/connections.ts` (`ConnState` loses `occupied` and `taken`; `takeOver`, `takeoverWanted`, `tabId`, the passive `url()` go; the base URL is `?pause=1&held=1` + `&go=1` on a local page), `web/src/core/net/socket.ts` (the 4001 branch, `reconnect()`, the `takeover` exception in `send`, `SocketState` `taken`), `web/src/core/store/store.ts` (`takeOver` thunk; `toastMiddleware`: on `serverEvent` `occupied` → `toast(t('oldServer'), '')`), `web/src/core/sdk/index.ts` (`chat.takeOver`), `web/src/App.tsx` (`blocked` without them, no `<OneTab />`), `web/src/core/shell/keymap.ts:82-84`, `web/src/core/shell/Favicon.ts:27-28`, `web/src/core/sdk/repository.ts:81`, `web/src/core/store/feed.ts:338-339` (keep ignoring `occupied`; `taken-over` too, an old server's), `web/src/plugins/comments/slice.ts:45-50` (the occupied/taken branch goes), i18n: remove `occupiedTitle`, `takenTitle`, `workHere`; add `oldServer` in all six LANGS
- Tests: `web/src/core/net/socket.test.ts:87-115`, `web/src/core/sdk/connections.test.ts:70-78`, `web/src/core/shell/keymap.test.tsx:253-260`; new cases in `web/src/core/sdk/connections.test.ts` and `web/src/core/store/store.test.ts` (or the existing toast middleware test file)

**Interfaces:**
- Consumes: nothing from Task 1 at the type level.
- Produces: `ConnState = 'connecting' | 'open' | 'closed' | 'unauthorized' | 'stopped'`; i18n key `oldServer`.

`oldServer` copy: en "The server is older than this page: restart it (▾ → Restart the server)."; ru "Сервер старше этой страницы: перезапусти его (▾ → «Перезапустить сервер»)."; de/es/pt-BR/zh-CN follow the wording of their `agentOldServer` up to the colon's clause, without its "then the tab reads again" tail.

- [ ] **Step 1: Write the failing tests**

```ts
// connections.test.ts
it('the socket url has no tab= or passive=1: ?pause=1&held=1 (+ &go=1 on a local page)');
it('an occupied event leaves the state connecting and sends no takeover');
// store toast test
it('occupied from an older server shows one oldServer toast');
```

- [ ] **Step 2: Run:** `npx vitest run web/src/core` — Expected: FAIL (url has `tab=`; state becomes `occupied`).

- [ ] **Step 3: Implement the removals and the toast** (files above). `socket.ts` keeps "nothing goes out before the replay" for every message.

- [ ] **Step 4: Run:** `npx tsc -b && npx vitest run web && npm run build -w web` — Expected: PASS, including `i18n.test.ts`, `tooltips.test.ts`, `theme.test.ts`, `scripts/boundaries.test.ts`.

- [ ] **Step 5: Commit** `gh-174: the page has no Work here overlay; an older server's occupied is a toast`

### Task 3: E2E: two live pages

**Files:**
- Create: `e2e/clients.spec.ts` (replaces `e2e/onetab.spec.ts`, deleted; same `@chat` fixture, 4791)
- Modify: `e2e/comments.spec.ts:270-295` (the two pages are both live: no `onetab` test id, no Work here; the comment made on one shows on the other)

- [ ] **Step 1: Write `e2e/clients.spec.ts`**

```ts
test('two pages of one window are both live: a send from either shows in both @chat');
test('reloading a page while another is open never shows an overlay and both keep working @chat');
test('an ask answered on one page is resolved on the other @chat'); // only if the chat fixture has a permission turn; else drop and say so in the PR
```

- [ ] **Step 2: Run:** `npm run e2e -- e2e/clients.spec.ts e2e/comments.spec.ts` — Expected: PASS.

- [ ] **Step 3: Commit** `gh-174: e2e: two live pages of one window`

### Task 4: Docs

**Files:**
- Modify: `docs/guide.md` (~88–90, 594, 630, 641: a window is live on every tab, the phone and another computer at once; no Work here; the phone app keeps its Work here until it updates), `docs/architecture.md` (154, 221, 418, 566–577: the takeover section becomes "every socket is attached", heartbeat per socket, `open-agent` to the newest local `go=1` socket), `docs/agent-reference.md` (103, 292: 4001 is gone from the audit note; 347), `CHANGELOG.md` (Unreleased: one entry), the spec `docs/superpowers/specs/2026-11-27-clients-in-sync-design.md` (already in the worktree)

- [ ] **Step 1: Edit the docs** (Occam: say what changed, no history).
- [ ] **Step 2: Run the full suite** `python3 /tmp/nb-suite.py` — Expected: unit 0, build 0, e2e 0.
- [ ] **Step 3: Commit** `gh-174: docs: every client of a window is live`
