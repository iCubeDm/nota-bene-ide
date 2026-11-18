# M0 Foundation Implementation Plan

**Goal:** A minimal but usable Nota Bene. Chat with the real Claude Code agent in the new React UI: streaming replies, mid-turn sends, interrupt, permission cards, replay, i18n. Everything is covered by e2e tests on a fake agent.

**Architecture:** npm workspaces `shared/` (protocol types), `server/` (Node running TS natively; `AgentSession` abstraction with `SdkAgent` and `FakeAgent`; `EventHub` with replay; one WebSocket) and `web/` (Vite + React + Redux Toolkit; server events become `serverEvent` actions folded by a pure feed reducer). The server serves the built `web/dist`.

**Stack:** Node 26 (type stripping), TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.310, `ws`, Vite 8, React 19, Tailwind 4, shadcn/ui, Redux Toolkit, marked + DOMPurify + highlight.js + mermaid, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-nota-bene-rebuild-design.md` (parity checklist "Chat (M0)").

## Constraints

- Node >= 23.6; the server runs `.ts` directly; `erasableSyntaxOnly: true` (no enums, namespaces, parameter properties).
- Server listens on `127.0.0.1` only; default port 4777 (`--port`).
- No runtime state in the repo: `~/.nota-bene/` (override `NOTA_BENE_HOME`).
- Every user-visible string goes through `t()`, with keys in both `ru` and `en`.
- Exact dependency versions; SDK pinned at `0.3.310`.
- `prototype/` is not modified. Palette and chrome tokens are copied from the prototype's `:root`: visual parity, not a redesign.

## Commit convention

One task = one small commit (about 300 changed lines or fewer, excluding lockfiles and generated shadcn files), code plus its tests, no drive-by fixes. Commit only when the task's tests pass and `npx tsc -b` is clean. Conventional Commits subject; body lines What / Why / Verified by; trailer `Task: M0-NN`. Tag `m0` at the end.

## Review focus (each has a test)

1. Malformed or unknown WebSocket message: a `server-error` event, the server keeps serving (M0-08).
2. Reconnect mid-stream: the replay shows the partial text once, live deltas continue it, no duplicated block (M0-13).
3. Sending while the socket is down: text stays in the composer, offline state shown, nothing silently dropped (M0-15, M0-18).
4. Interrupt while idle: no error, no state change (M0-04).
5. Agent crash mid-turn: an error item in the feed, `busy` cleared, next send starts a fresh agent on the same transcript (M0-06).

## File layout

```
package.json, tsconfig.base.json, vitest.config.ts
shared/src/protocol.ts     ClientMessage, ServerEvent, parseClientMessage
server/src/  main.ts (CLI) state.ts agent/{types,fake,sdk,transcript}.ts
             hub.ts errors.ts session.ts http.ts server.ts   test/fixtures/*.json
web/src/     main.tsx App.tsx theme.css shell/ i18n/{index,ru,en}.ts
             store/{feed,store}.ts net/socket.ts feed/ composer/Composer.tsx
e2e/{playwright.config.ts,chat.spec.ts}
```

## Contracts

Protocol (`@nota-bene/shared`):
```ts
export type ClientMessage =
  | { type: 'send'; id: string; text: string; force?: boolean }
  | { type: 'interrupt' }
  | { type: 'permission'; id: string; allow: boolean };
export type ServerEvent =
  | { kind: 'replay'; events: ServerEvent[] }
  | { kind: 'sdk'; m: SDKMessage; ts: number }
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; historic?: boolean }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; ts: number }
  | { kind: 'permission-done'; id: string; allow: boolean; ts: number }
  | { kind: 'session'; id: string | null; root: string }
  | { kind: 'server-error'; where: string; message: string };
parseClientMessage(raw): ClientMessage | { error: string }   // hand-written guards, no schema library
```

Agent (`server/src/agent/types.ts`):
```ts
type PermissionAsk = (toolName, input, signal: AbortSignal) => Promise<boolean>;
interface AgentSession { messages: AsyncIterable<SDKMessage>;   // ends after close()
  send(m: { uuid; text; priority: 'next' | 'now' }): void;
  interrupt(): Promise<void>;   // no-op when idle
  close(): void }
interface AgentBackend { start(o: { cwd; resume?; ask }): AgentSession;
  history(sessionId, cwd): Promise<ServerEvent[]> }
```

Other server pieces:
- `state.ts`: `stateDir()`, `lastSession(dir)`, `saveSession(dir, id|null)` (null deletes). `sessions.json` written to a temp file then `renameSync`; a corrupt file reads as `undefined`.
- `FakeTurn = { text; chunk?(8); delayMs?(0); tools?; ask?; crash? }`; `fakeBackend(turns)` emits `system/init` (`session_id: 'fake-session'`), then per send `stream_event` start and delta chunks, `assistant` (`fake-a-<n>`, with tool_use blocks), the `ask`, then `result` with `duration_ms`. `crash` throws after the first delta. Turns used in order, last repeats; `history()` returns `[]`.
- `EventHub`: `emit(ev, {store?})` (store default true, stamps `ts`); `attach(sock)` sends `{kind:'replay', events}` first and returns detach; `reset(events?)`. `reportError(hub, where, e)` = console.error + `server-error` with `store:false`; `guard()` wraps sync throws.
- `SessionManager` (`createSessionManager({hub, backend, cwd, resume?})`): `send`, `interrupt`, `answer`, `info`. `send` emits `user`, then `agent.send` with priority `now` if `force` (interrupting first) else `next`. `system/init` saves the session id and emits `session`. With `resume`, `hub.reset(await backend.history(...))` first. A permission ask emits `permission`, `answer()` emits `permission-done`. When the iterator throws: `reportError` plus a stored error `result` (`error_during_execution`, `is_error`); the next send starts a new agent with `resume` = last session id.
- `httpHandler({hub, webDist, info, extra?})`: `GET /info`; static files with `index.html` fallback; `..` gives 403; one try/catch, a throw gives 500 plus `reportError`.
- `startServer({cwd, port, backend, resume?, webDist})` returns `{url, close()}`. Each socket is attached to the hub; frames go through `parseClientMessage`; `{error}` becomes `reportError(hub,'ws')`; `uncaughtException`/`unhandledRejection` also reported.
- `sdkBackend()`: `query()` with streaming input, `includePartialMessages`, `permissionMode: 'auto'`, `systemPrompt` preset `claude_code` plus the prototype's `APPEND` text verbatim, `extraArgs: {chrome: null}`, `canUseTool` = `ask`. `history()` = `transcriptToEvents(getSessionMessages(id,{dir}))` (pure; skips tool_result-only user turns; `historic: true`; images come in M2). No unit test for `sdk.ts` (thin adapter, covered by the real-agent smoke).
- CLI: `parseArgs(argv, cwd)` gives `{dir, port(4777), resume?, continue, fake?}`; usage `node server/src/main.ts [dir] [--port N] [--resume ID] [--continue] [--fake script.json]`; `--continue` resolves via `lastSession`; `--fake` uses `fakeBackend`; non-numeric port throws usage; `main()` runs only as entry point.

Web pieces:
- Scaffold: `web/vite.config.ts` proxies `/info` and the WebSocket to `127.0.0.1:4777`; `theme.css` maps prototype tokens into Tailwind 4 `@theme`; header 48px, paper card over the 24px grid; shadcn `button` and `tooltip`; icons copied from `prototype/public/`.
- i18n: `Lang = 'ru'|'en'`; `t(key, ...args)`, `useT()`, `setLang()` (localStorage `lang`), `initialLang(navLang, stored)` (stored wins, else browser language). Dictionaries copied from the prototype's `STR`; header RU/EN toggle.
- Feed reducer `reduce(state, ev)` (pure, exhaustive switches). `FeedItem` kinds: `user` (with `force`, `duringWork`), `assistant` (id `${uuid}:${blockIndex}`, `stream:${n}` while streaming, `final`), `tool` (`name`, `arg`, `sub`, `error`), `done` (`secs`, `interrupted`, `error`), `permission` (`answer?`), `notice`. `FeedState = {items, busy, session, forcePending}`; `replay` folds from `emptyFeed`. Tool `arg` = first of `command, file_path, pattern, description, url, query, skill, prompt`, first line, 160 chars. A force send keeps `busy` across the interrupted result; subagent tool lines are `sub`, subagent text is not added.
- Socket: `connect(url, onEvent, onState, WS?)` returns `{send(m): boolean, close()}`; reconnects every 1000 ms; `send` false when not open.
- Store: `serverEvent` is the only way server data enters the store; `feedSlice`, `connSlice`, `makeStore({url, connect?})` with socket middleware; thunks `sendMessage(text, force)` (uuid via `crypto.randomUUID()`, false while closed), `interrupt` (no-op when idle), `answerPermission`; DevTools only in dev.
- `Markdown`: marked + DOMPurify (allow `video`, `audio`, `controls`, `preload`) + highlight.js. When `final`, a mermaid fence renders through mermaid (dark theme) and an svg fence as sanitised SVG; non-final stays code. Images point to `/file?path=` (route comes in M2).
- Feed components match the prototype: user bubble with meta line, `▸ Tool · arg` lines (sub indented, errors red), done line, permission card, auto-scroll only when at the bottom.
- Composer keys: Enter sends, Shift+Enter newline, Cmd/Ctrl+Enter forces when busy, Esc interrupts when busy; field grows to 40vh; Stop enabled only while busy; failed send keeps the text and shows `t('offline')`.

## E2E and wrap-up

- Playwright `webServer` builds web and runs the server on port 4791 with a fake script and a temp `NOTA_BENE_HOME`; one project per fixture (`chat.json`, `slow.json`, `ask.json`). Seven specs: streamed markdown reply with mermaid and done line, mid-turn send marked, force send interrupts, Esc/Stop interrupt, permission allow, reload replays, language toggle.
- Root scripts: `dev` (concurrently server `--watch` on 4777 and vite), `start` (build web, run server), `e2e`, `test`. Ports: 4777 real use, 4790 smoke, 4791 e2e. Root `CLAUDE.md` documents them.
- Manual real-agent smoke on port 4790 with temp dirs: create a file, answer a permission card, send mid-turn, interrupt, restart with `--continue` and see the replay.

## Tests per task (summary)

M0-01 scaffold smoke; M0-02 five protocol validation cases; M0-03 four state cases (incl. atomic write); M0-04 six fake cases (stream order, ask waits, interrupt mid-turn and idle, crash); M0-05 four hub cases; M0-06 five session cases; M0-07 five http cases; M0-08 three server cases; M0-09 three transcript cases; M0-10 three CLI cases; M0-12 i18n key parity and `initialLang`; M0-13 seven reducer cases; M0-14 three socket cases; M0-15 four store cases; M0-16 four markdown cases; M0-17 three feed cases; M0-18 three composer cases; M0-19 seven e2e specs.
