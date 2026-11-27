# The composer draft is shared, per session (issue 174, PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, test first.

**Goal:** the composer's text and uploaded images are the open session's draft, kept by the server: every client of the
window shows it, the last write wins, a send clears it everywhere, and it survives a reload, a restart and an update.

**Architecture:** a `DraftStore` (one file per session, debounced) on the server, a `draft` client message and a `draft`
event (`store:false`, with the writer's `ack`); on the web a listener in the composer plugin (`draftSync.ts`) applies the
last-write-wins rule of the spec and throttles the writes. The phone is not touched (it keeps its local draft until PR 4).

**Spec:** `docs/superpowers/specs/2026-11-27-clients-in-sync-design.md` §3, §5 (protocol 40), §7, §8 "Drafts", §9 item 2.

## Global Constraints

- `PROTOCOL = 40`, `FEATURES.draft = 40`; `npm run gen:protocol`; the pin in `scripts/protocol/dart.test.ts`.
- Drafts are never audited, never stored in the replay, and the server never clears one on `send`.
- No new user-visible string is expected; any that appears goes into all six LANGS.
- Ports 4790–4795 only, a temporary `NOTA_BENE_HOME`; commits `gh-174: …` with the Co-Authored-By trailer.

### Task 1: shared: the `draft` message and event, protocol 40

- Modify `shared/src/protocol.ts`: `DraftImage = {id, mediaType}`, `DRAFT_MAX = 256 * 1024`, ClientMessage
  `{type:'draft'; id; sessionId: string|null; text; images?}`, ServerEvent `{kind:'draft'; sessionId; text; images?; ack?}`,
  `parseClientMessage` case `draft` (id 1–100 chars, sessionId null or string, text ≤ DRAFT_MAX, images valid refs);
  `PROTOCOL = 40` with its doc line. `shared/src/features.ts`: `draft: 40`.
- Generated: `mobile/protocol/lib/src/protocol.g.dart`; pin 40 in `scripts/protocol/dart.test.ts`.
- Tests (`shared/src/protocol.test.ts`): `a draft parses with its images and a null session`, `an oversized or malformed
  draft is refused`.

### Task 2: server: `DraftStore`

- Create `server/src/drafts.ts`: `type Draft = {text; images: DraftImage[]}`; `class DraftStore({dir, delayMs?})` with
  `get(id|null): Draft`, `set(id|null, d)`, `adopt(id)`, `dropPending()`, `forget(id)`, `flush()`.
  `<dir>/<id>.json` `{v:1, text, images}` (mode 0600, `writeJsonAtomic`, `SAFE_SESSION_ID`); an empty draft removes the
  file; unwritten values live in memory and are written 1 s after the last change; `get` reads the file otherwise.
- Tests (`server/src/drafts.test.ts`): `a draft is written after the delay and read back by another store`,
  `an empty draft removes its file`, `the null session stays in memory, is adopted under the first id, dropped otherwise`,
  `forget removes the file and the unwritten value`, `an unsafe id is refused`.

### Task 3: server: wiring in `agent.ts`

- `case 'draft'`: store under `msg.sessionId ?? current`; broadcast `{kind:'draft', sessionId, ...d, ack}` only when it
  is the current session and no switch runs. `broadcastDraft()` in the attach (after `comments`), in `onSwitch`
  (after `dropPending` when not a restart, and a flush), in `onSessionId` (adopt when `prev === null`) and in
  `switchFailed`. `forgetDeleted` forgets it; `close()` flushes. `audit.ts`: `case 'draft': return`.
- Tests (`server/src/drafts.test.ts`, socket part): `attach carries the current session's draft`, `a write reaches every
  socket with the writer's ack`, `a write tagged with the previous session after a switch lands there and is not shown`,
  `a switch sends the new session's draft`, `the null session's draft is adopted under its first id`, `a switch drops
  the null session's draft`, `a deleted session's draft goes`, `the draft survives a server restart`, `an invalid draft
  is refused and stores nothing`; `audit.test.ts`: `a draft is not audited`. Fix event-order assertions in
  `switch.test.ts` and others.

### Task 4: web: `EditorField` applies an outside value as a minimal change

- Modify `web/src/core/components/field/EditorField.tsx` `value` effect: the common prefix and suffix are cut off,
  CodeMirror maps the selection; the caret goes to the end only when the field was empty.
- Tests (`EditorField.test.tsx`): `an outside change keeps the caret in place`, `an outside change before the caret
  moves it along`.

### Task 5: web: the sync

- `web/src/core/store/message.ts`: `imagesApplied(images)` (clears `marking` when that image went); exported by the sdk.
- `web/src/plugins/composer/slice.ts`: `sync: {scope?, pending, dirty, typedInSwitch}`, `draftApplied`, `draftEdited`,
  `draftWritten`, `draftSynced`, `flushDraft`; a non-open `connState` turns `pending` into `dirty`.
- Create `web/src/plugins/composer/draftSync.ts`: `received(sync, ev, switching)` (the rule: echo, same scope, `null`
  scope retag, scope change with the old-scope write and `typedInSwitch`), the `writeDraft` thunk (gated on
  `has(protocol,'draft')`, `DRAFT_MAX`, not in a switch) and `draftListeners` (edits, 300 ms leading/trailing throttle,
  `flushDraft`, `draft`, `hello`, the end of a switch).
- `send.ts`, `refused.ts`, `shellMode.ts`: `flushDraft()` after the change; `Composer.tsx`: flush on blur, `pagehide`,
  `visibilitychange` hidden; `plugin.ts`: listeners, and `pause` counts the draft only while unsynced.
- Tests (`draftSync.test.ts`): `own echo leaves the text`, `a foreign draft applies when clean, not when dirty`,
  `scope change writes the dirty text to the old session and shows the new one`, `typing in a switch carries the text
  to the new session`, `adoption keeps a dirty text`, `reconcile at hello, the attach draft before it`, `a send
  flushes ''`, `no write below 40`, `an oversized draft stays local`, `a foreign draft replaces the images`,
  `the update pause counts only an unsynced draft`.

### Task 6: e2e

- `e2e/clients.spec.ts` (@chat): `a draft typed in one page shows in the other; a send from it clears both; a reload
  keeps it`. `e2e/controls.spec.ts` (@controls, the fixture with sessions): `each session shows its own draft`.

### Task 7: docs

- `docs/guide.md` (composer: the draft is shared and per session), `docs/architecture.md` (`drafts.ts`, the frames),
  `CHANGELOG.md` `## Unreleased`.
