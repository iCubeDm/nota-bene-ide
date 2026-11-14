# Remote access from the window: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every window keeps one shared `nota-bene remote` connector running while a relay is saved, shows its state in the header, and offers a Remote tab that does what the terminal commands do.

**Architecture:** A per-window `RemoteKeeper` (server) polls the connector's control socket every 5 s, spawns `nota-bene remote --managed` detached under `remote/spawn.lock` when nobody answers, and turns the answers into a `RemoteState` sent to the page as a `remote` event (protocol 20). Routes under `/remote` change the config, pair and revoke through the same control socket. The web keeps the state in a slice, draws an indicator beside Usage and a `remote` tab.

**Tech Stack:** Node TypeScript server (Vitest), React + Redux Toolkit web (Vitest + Testing Library), `uqr` for the QR SVG.

**Spec:** `docs/superpowers/specs/2026-11-13-remote-from-window-design.md`

## Global Constraints

- Tests use only ports 4790–4795 and a temporary `NOTA_BENE_HOME`; never touch the user's `~/.nota-bene`, never probe a live window.
- No connector is ever spawned by a test server unless the test asks for it (`startServer` gets `remote: false` by default in tests).
- Every user-visible string in all six `LANGS` (`web/src/i18n/{en,ru,de,es,pt-BR,zh-CN}.ts`) with a real translation.
- Neutral fixtures (`wss://relay.example.com`, device names like `Test phone`).
- Never log secrets: the pairing URI, the secret and the host key never go to a log or the audit.
- Branch `feat/gh-369-remote-tab`; commits `gh-369: …`.

## Review Focus

- A second window starting at the same moment as the first: exactly one connector (Task 3, "two keepers spawn once").
- The off switch with a connector running by hand: it stops (Task 3, "off stops a hand-started connector").
- The relay refusing the host (4402): red state with the reason, no respawn loop (Task 3, "fatal error backs off").
- A phone calling `/remote/pair` through the relay: refused (Task 1, `goodPath`).
- A page newer than its server (protocol 19): no indicator, no tab (Task 6, "hidden for an older server").

---

### Task 1: Connector side: config, last error, status fields, `stop`, idle exit, phone filter

**Files:**
- Modify: `server/src/remote/store.ts` (config, last error)
- Modify: `server/src/remote/connector.ts` (options, status, `stop`, idle, fatal record)
- Modify: `server/src/remote/cli.ts` (`--managed`, `enabled` on hand start)
- Modify: `server/src/remote/device.ts:21` (`goodPath`)
- Test: `server/src/remote/store.test.ts`, `connector.test.ts`, `device.test.ts`

**Interfaces:**
- Produces:
  - `readConfig(): { relay?: string; enabled?: boolean }`, `writeConfig(c: { relay?: string; enabled?: boolean })` (`enabled` written only when `false`, so absent means on)
  - `export function checkRelay(url: string): void` (now exported)
  - `type LastError = { code: number; message: string; at: number }`; `readLastError(): LastError | null`, `writeLastError(e: LastError)`, `clearLastError()` on `remote/last-error.json` (private file, as config)
  - `new Connector({ relay, managed?: boolean, idleExitMs?: number (default 60_000), version?: string, … })`
  - Connector event `exit(reason: 'stop' | 'idle')`
  - control `status` answer gains `version?: string`, `managed: boolean`, `pairing: { expiresAt: number } | null`; each device view gains `pairedAt: number` (`addedAt`)
  - control op `stop` → answers `{ ok: true }`, then emits `exit('stop')`
  - the `fatal` path also calls `writeLastError({ code, message, at: Date.now() })`; a successful `online` calls `clearLastError()`

- [ ] **Step 1: Failing tests**
  - store: `writeConfig({ relay: 'wss://relay.example.com', enabled: false })` then `readConfig()` → `{ relay: 'wss://relay.example.com', enabled: false }`; `writeConfig({ relay })` → `readConfig().enabled` undefined; `writeLastError` / `readLastError` round trip, `clearLastError()` → null.
  - connector (existing harness with `testRelay.ts`): `status` has `managed: false`, `version: '9.9.9'` when given, `pairing: null`, then `{ expiresAt }` after `pair`; device has `pairedAt`.
  - connector: op `stop` answers `{ ok: true }` and `exit` fires with `'stop'`.
  - connector: `managed: true, idleExitMs: 50` with a `Windows` stub whose `list()` is `[]` → `exit('idle')` within 500 ms; with one window listed → no `exit` in 200 ms.
  - connector: a relay closing with 4402 → `readLastError()?.code === 4402`.
  - device: `goodPath('/remote')`, `'/remote/pair'`, `'/remote?x=1'` false; `'/remotely.md'` true (a file route is not caught).
- [ ] **Step 2: Run** `npx vitest run server/src/remote` → the new tests FAIL.
- [ ] **Step 3: Implement.** Idle: on `windows` `change` and every `idleExitMs / 4`, an empty list for `idleExitMs` emits `exit('idle')` (managed only). The `fatal` event needs the code: change the relay listener to keep `code`. In `cli.ts`: `--managed` flag; a hand start writes `enabled` back on (`writeConfig({ ...readConfig(), enabled: undefined })`, i.e. drops it) before connecting; a managed start with `enabled === false` exits 0 at once; the run resolves on `exit` (code 0) as on SIGTERM; pass `version` (the package version, read from `package.json` two levels above `cli.ts`'s folder in a checkout and beside `bin/` in the package: use the existing helper if `runtime.ts` has one, otherwise read `<repo>/package.json`).
- [ ] **Step 4: Run** `npx vitest run server/src/remote` → PASS; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `gh-369: the connector reports version and pairing, stops on request, exits idle when managed`.

### Task 2: Protocol 20: the `remote` and `remote-pair` events

**Files:**
- Modify: `shared/src/protocol.ts` (types, `PROTOCOL = 20`, history line)
- Regenerate: `mobile/protocol/` (`npm run gen:protocol`)
- Modify: `web/src/store/feed.ts` (the two kinds return `s`)

**Interfaces:**
- Produces (shared):
  ```ts
  export type RemoteDevice = { id: string; name?: string; fingerprint: string; online: boolean; pairedAt: number };
  export type RemoteState = {
    configured: boolean; enabled: boolean; running: boolean; online: boolean;
    relay: string | null; hostFingerprint: string | null; devices: RemoteDevice[];
    pairing: { expiresAt: number; mine: boolean } | null;
    /** the connector answers but cannot be switched from here: started in a terminal by a version without `stop` */
    legacy: boolean;
    lastError: { code: number; message: string; at: number } | null;
    /** the keeper tried to start it and it did not come up (and no relay error explains it) */
    startFailed: boolean;
  };
  // ServerEvent additions
  | { kind: 'remote'; state: RemoteState }
  | { kind: 'remote-pair'; result: 'paired' | 'refused' | 'expired' | 'cancelled'; device?: RemoteDevice; fingerprint?: string }
  ```
- [ ] **Step 1:** Add the types and the history line `// 20: remote access from the window: the server's `remote` (state) and `remote-pair` events and the `/remote` routes; an older server has neither, so the page shows no indicator.`
- [ ] **Step 2:** `npm run gen:protocol`; `npx tsc -b` → clean (feed.ts `never` check forces the two cases).
- [ ] **Step 3: Commit** `gh-369: protocol 20: remote state events`.

### Task 3: `RemoteKeeper`: ensure, spawn, back-off, state

**Files:**
- Create: `server/src/remote/keeper.ts`
- Test: `server/src/remote/keeper.test.ts`

**Interfaces:**
- Consumes: Task 1 store/control functions; `controlClient`, `running` from `control.ts`; `takeLockFile`, `readLock` from `../runtime.ts`; `HIDDEN`, `renameRetry` from `../platform.ts`.
- Produces:
  ```ts
  export const ENSURE_MS = 5000;
  export const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
  export class RemoteKeeper extends EventEmitter { // event 'state'(RemoteState) on change, 'pair'(Omit<remote-pair event, 'kind'>)
    constructor(o?: { version?: string; spawn?: () => void; pollMs?: number; spawnWaitMs?: number; now?: () => number });
    start(): void; stop(): void;          // interval unref'd; stop never stops the connector
    state(): RemoteState;                  // last computed
    refresh(): Promise<RemoteState>;       // one ensure pass now
    setConfig(c: { relay?: string; enabled?: boolean }): Promise<RemoteState>;  // throws on a bad relay (checkRelay message)
    pair(): Promise<{ uri: string; qr: string; hostFingerprint: string; expiresAt: number }>; // throws when not running
    cancelPair(): void;
    revoke(id: string): Promise<{ ok: boolean; error?: string }>;
  }
  ```
- Default `spawn`: `spawn(process.execPath, [<repo>/bin/nota-bene.mjs, 'remote', '--managed'], { detached, stdio: ['ignore', log, log], cwd: remoteDir(), env: as hostClient's hostEnv, ...HIDDEN })`, log `remote/connector.log`, previous moved to `.1`, child `unref()`.

Ensure pass (the algorithm the tests pin):
1. `status` over `controlClient()` (2 s). Answer → `running`; a managed answer with another `version` → send `stop`, wait for the socket to go, continue as not running; no `version` → `legacy: true`.
2. Not running, the config has a relay, `enabled !== false`, and `now >= retryAt` → take `remote/spawn.lock` (`takeLockFile(lock, token)`; held by a live pid → just wait for the socket), check again, spawn, wait up to `spawnWaitMs` (10 s) for `running()`. Release the lock if `readLock` still shows our token.
3. A spawn that did not come up, or a connector gone with `last-error.json` present → `failures++`, `retryAt = now + BACKOFF_MS[min(failures-1, 3)]`; `startFailed` true unless `lastError` explains it. Coming up resets both.
4. Emit `state` when the JSON differs from the last one.

`setConfig`: `writeConfig({...readConfig(), ...c})` (relay checked first), `clearLastError()`, reset back-off; off or a new relay with a connector running → `stop` it (a legacy one cannot be stopped: the caller gets 409, see Task 4); then `refresh()`.

`pair`: a `controlClient` kept open; `{op:'pair'}`; the `code` message → `qr = renderSVG(uri)` from `uqr`; later messages → `emit('pair', …)` (`paired` with the device view, `refused` with `fingerprint`, `expired`, `cancelled`) and `refresh()`. `cancelPair` closes that client (the connector ends a pairing whose client went).

- [ ] **Step 1: Failing tests** (temporary `NOTA_BENE_HOME`; `spawn` injected to start an in-process `Connector` against `testRelay.ts` on a port in 4790–4795, managed, with the version given):
  - "no relay: nothing spawns, state off" → `spawn` not called, `configured: false`.
  - "a saved relay starts one" → after `refresh()`, `running: true`, then `online: true`.
  - "two keepers spawn once": two keepers `refresh()` together → `spawn` called once in total, both `running`.
  - "a hand-started connector is reused": a connector started before (not managed) → no `spawn`, `running`.
  - "off stops a hand-started connector": `setConfig({ enabled: false })` → the connector's `exit('stop')`, state `enabled: false, running: false`, and a `refresh()` spawns nothing.
  - "another managed version is replaced": running managed `version: '0.0.1'`, keeper `version: '9.9.9'` → `stop` sent and one new `spawn`.
  - "fatal error backs off": `spawn` that writes `last-error.json` `{code: 4402}` and starts nothing → `lastError.code === 4402`; a second `refresh()` within 60 s does not spawn; with `now` + 61 s it does; `setConfig({ relay })` clears it and spawns at once.
  - "pairing outcome": `pair()` returns an `<svg` `qr` and `nbremote://` `uri`; a `testPhone.ts` pairing → `pair` event `paired` with `device.fingerprint`; state `devices.length === 1`.
  - "cancel ends the pairing": `pair()` then `cancelPair()` → state `pairing: null` after `refresh()`.
- [ ] **Step 2: Run** `npx vitest run server/src/remote/keeper.test.ts` → FAIL.
- [ ] **Step 3: Implement** `keeper.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `gh-369: a window keeps the connector running`.

### Task 4: Routes and the window wiring

**Files:**
- Create: `server/src/remote/routes.ts`; Test: `server/src/remote/routes.test.ts`
- Modify: `server/src/server.ts` (routes, attach, events), `server/src/main.ts` if options are threaded there

**Interfaces:**
- Consumes: `RemoteKeeper` (Task 3), `RemoteState` (Task 2).
- Produces: `remoteRoutes(o: { hub: EventHub; keeper: Pick<RemoteKeeper, 'state' | 'refresh' | 'setConfig' | 'pair' | 'cancelPair' | 'revoke'> }): Record<string, RequestListener>`; `startServer` option `remote?: RemoteKeeper | false` (false: no keeper, no routes answer 503; the default in tests).
- Routes: `GET /remote` → `RemoteState` (after `refresh()`); `POST /remote/config {relay?: string, enabled?: boolean}` → 200 state, 400 `{error}` bad relay or types, 409 `{error:'legacy'}` when the switch cannot reach the connector; `POST /remote/pair` → 200 `{uri, qr, hostFingerprint, expiresAt}`, 409 `{error:'not running'}`; `POST /remote/pair/cancel` → 200; `POST /remote/revoke {id}` → 200 `{ok, error?}`. Non-POST → 405. All key tier (the default).
- Wiring: keeper `state` → `hub.emit({kind:'remote', state}, {store:false})`; `pair` → `hub.emit({kind:'remote-pair', ...}, {store:false})`; `attachOwner` sends `{kind:'remote', state: keeper.state()}`; keeper `start()` on listen, `stop()` on close. `pairing.mine` is true only in the window whose keeper holds the pairing client.

- [ ] **Step 1: Failing tests** (routes with a fake keeper): GET shape; `config` 400 on `{enabled:'yes'}`; `config` passes `{relay}` through; `pair` 409 when the fake throws `not running`; GET of `/remote/pair` → 405. A `server.test.ts` case: a socket attached to a server with a fake keeper receives a `remote` event; a server with `remote: false` answers `/remote` 503.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run server/src/remote server/src/server.test.ts` → PASS.
- [ ] **Step 5: Commit** `gh-369: /remote routes and the remote event`.

### Task 5: Web slice, tab kind and header indicator

**Files:**
- Create: `web/src/remote/slice.ts`, `web/src/remote/RemoteButton.tsx`, `web/src/remote/api.ts`
- Modify: `web/src/store/store.ts` (reducer), `web/src/tabs/slice.ts` (`{id:'remote', kind:'remote'}`, `openRemote`), `TabStrip.tsx` (`ICONS.remote`, label), `TabsMenu.tsx` (label), `shell/Header.tsx` (button before `usageBtn`), i18n ×6
- Test: `web/src/remote/RemoteButton.test.tsx`

**Interfaces:**
- Produces: `remoteSlice` state `{ supported: boolean; state: RemoteState | null; pair: RemotePairEvent | null }` (`supported` from `hello.protocol >= 20`); `selectRemote`; `indicator(state): 'off' | 'connecting' | 'online' | 'trouble'`:
  - off: `!configured || !enabled`
  - trouble: `lastError || startFailed`
  - online: `online`
  - connecting: otherwise
  `api.ts`: `getRemote()`, `postRemote(path, body)` via `apiFetch`.
- Button: `id="remoteBtn"`, dot `data-state={indicator}`, count of online devices when online and > 0, `title` = the state in words (+ `lastError.message` or the log hint), click → `openRemote()`. Rendered only when `supported`.

- [ ] **Step 1: Failing tests**: hidden for protocol 19; each of the four states sets `data-state` and its tooltip; online with two online devices shows `2`; click opens the `remote` tab.
- [ ] **Step 2–4:** run `npx vitest run web/src/remote` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `gh-369: the header shows the remote state`.

### Task 6: The Remote tab

**Files:**
- Create: `web/src/remote/RemoteView.tsx`; Test: `web/src/remote/RemoteView.test.tsx`
- Modify: `web/src/tabs/Panes.tsx`, i18n ×6

**Interfaces:**
- Consumes: Task 5 slice and api.
- Sections (spec "Remote tab"): Access (switch disabled when `legacy`, with the legacy note; relay text with Edit → field + Save; host fingerprint; no relay → field + Save + a line and a link to the guide's remote section); Pair a phone (button → POST pair → QR `dangerouslySetInnerHTML` of the server's SVG, `uri` with Copy, fingerprint, minutes left, Cancel; `remote-pair` outcomes in place; `pairing && !pairing.mine` → "a pairing is in progress in another window"); Phones (name, fingerprint, online, paired date, Revoke → inline Confirm/Cancel).
- [ ] **Step 1: Failing tests**: no relay → the field and Save, Save posts `{relay}`; a 400 shows the server's error; the switch posts `{enabled:false}`; legacy disables it and shows the note; Pair shows the `svg` and `nbremote://` text; a `remote-pair paired` event shows the name and fingerprint; Revoke asks, Confirm posts `{id}`; "hidden for an older server": no tab content rendered when `!supported` (the pane says the server is too old).
- [ ] **Step 2–4:** run FAIL → implement → PASS; `npm run build -w web`.
- [ ] **Step 5: Commit** `gh-369: the Remote tab`.

### Task 7: Docs, full checks, smoke

**Files:** `docs/guide.md` (remote section: the tab and the indicator; the terminal commands stay), `CHANGELOG.md` (Unreleased).

- [ ] **Step 1:** Docs.
- [ ] **Step 2:** `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e` (serialised): all exit 0.
- [ ] **Step 3:** Manual smoke on port 4790 with a temp `NOTA_BENE_HOME`, a local `testRelay` as `ws://127.0.0.1:4791`: save the relay in the tab, the dot goes green, Pair shows a QR, off stops the connector; screenshot.
- [ ] **Step 4: Commit** `gh-369: docs`; PR to main `gh-369: remote access from the window`.
