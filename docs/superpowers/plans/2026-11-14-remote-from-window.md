# Remote access from the window: implementation plan

**Goal:** Every window keeps one shared `nota-bene remote` connector running while a relay is saved, shows its state in the header, and offers a Remote tab that does what the terminal commands do.

**Approach:** A per-window `RemoteKeeper` (server) polls the connector's control socket every 5 s, spawns `nota-bene remote --managed` detached under `remote/spawn.lock` when nobody answers, and turns the answers into a `RemoteState` sent to the page as a `remote` event (protocol 20). Routes under `/remote` change the config, pair and revoke through the same control socket. The web keeps the state in a slice, draws an indicator beside Usage and a `remote` tab. `uqr` renders the QR SVG.

**Spec:** `docs/superpowers/specs/2026-11-13-remote-from-window-design.md`. Branch `feat/gh-369-remote-tab`, commits `gh-369: ...`.

## Constraints

- Tests use ports 4790-4795 and a temporary `NOTA_BENE_HOME`; never touch `~/.nota-bene` or a live window. A test server never spawns a connector unless asked (`startServer` gets `remote: false` by default in tests).
- Six `LANGS` with real translations. Neutral fixtures (`wss://relay.example.com`, `Test phone`). The pairing URI, secret and host key never reach a log or the audit.

## Connector side (`server/src/remote/`)

- store: `readConfig()/writeConfig({relay?, enabled?})` (`enabled` written only when `false`, absent means on); `checkRelay(url)` exported; `LastError {code, message, at}` with `readLastError/writeLastError/clearLastError` on `remote/last-error.json` (private).
- `Connector({relay, managed?, idleExitMs = 60_000, version?})`: event `exit('stop' | 'idle')`; `status` gains `version?`, `managed`, `pairing: {expiresAt} | null`; device views gain `pairedAt`; op `stop` answers `{ok:true}` then exits. Fatal relay close writes last-error (code kept from the relay listener); `online` clears it. Idle exit (managed only): an empty window list for `idleExitMs`, checked on `windows` change and every `idleExitMs / 4`.
- `cli.ts`: `--managed`; a hand start drops `enabled: false` from the config before connecting; a managed start with `enabled === false` exits 0 at once; the run resolves on `exit`; passes the package `version` (reuse a `runtime.ts` helper if any).
- `device.ts` `goodPath` refuses `/remote` and `/remote/...` (a phone cannot call `/remote/pair` through the relay) but not `/remotely.md`.

## Protocol 20

```ts
RemoteDevice = { id; name?; fingerprint; online; pairedAt }
RemoteState = { configured; enabled; running; online; relay: string|null; hostFingerprint: string|null;
  devices: RemoteDevice[]; pairing: {expiresAt; mine}|null;
  legacy: boolean;  // connector answers but cannot be switched from here (a terminal start by a version without `stop`)
  lastError: {code; message; at}|null; startFailed: boolean }  // keeper tried and it did not come up, no relay error explains it
ServerEvent += { kind:'remote'; state } | { kind:'remote-pair'; result:'paired'|'refused'|'expired'|'cancelled'; device?; fingerprint? }
```
`PROTOCOL = 20` with a history line; an older server has neither, so the page shows no indicator and no tab. `mobile/protocol` regenerated; `web/src/store/feed.ts` handles the two kinds.

## RemoteKeeper (`keeper.ts`)

`ENSURE_MS = 5000`, `BACKOFF_MS = [60s, 120s, 300s, 600s]`. API: `start/stop` (stop never stops the connector), `state()`, `refresh()`, `setConfig({relay?, enabled?})` (throws on a bad relay), `pair()` (throws when not running), `cancelPair()`, `revoke(id)`; events `state` on change and `pair`. Default `spawn` runs `bin/nota-bene.mjs remote --managed` detached, hidden window, log `remote/connector.log` (previous moved to `.1`), child unref'd.

Ensure pass:
1. `status` over the control socket (2 s). An answer means running; a managed answer with another `version` gets `stop`, wait for the socket to go, continue as not running; no `version` means `legacy: true`.
2. Not running, relay saved, `enabled !== false`, `now >= retryAt`: take `remote/spawn.lock` (held by a live pid: just wait for the socket), re-check, spawn, wait up to 10 s for the socket; release the lock if the token is still ours.
3. A spawn that did not come up, or a connector gone with `last-error.json` present: `failures++`, `retryAt = now + BACKOFF_MS[min(failures-1, 3)]`; `startFailed` true unless `lastError` explains it. Coming up resets both.
4. Emit `state` when the JSON differs.

`setConfig` writes config (relay checked first), clears last error, resets back-off, stops a running connector when switched off or the relay changes (a legacy one cannot be stopped: the route answers 409), then refreshes. `pair` keeps a control client open, renders the QR from the `code` message, and re-emits later outcomes (`paired`, `refused` with fingerprint, `expired`, `cancelled`); `cancelPair` closes that client (the connector ends a pairing whose client went).

Tests pin: no relay spawns nothing; a saved relay starts one; two keepers spawn once; a hand-started connector is reused; off stops a hand-started connector and nothing respawns; another managed version is replaced; a 4402 backs off (no spawn within 60 s, spawn after 61 s, new relay clears it); pairing outcome and cancel.

## Routes and wiring (`routes.ts`, `server.ts`)

`remoteRoutes({hub, keeper})`; `startServer` option `remote?: RemoteKeeper | false` (false: no keeper, routes answer 503). Key tier. `GET /remote` returns state after `refresh()`; `POST /remote/config {relay?, enabled?}` (400 `{error}` on bad relay or types, 409 `{error:'legacy'}`); `POST /remote/pair` returns `{uri, qr, hostFingerprint, expiresAt}` (409 `not running`); `POST /remote/pair/cancel`; `POST /remote/revoke {id}` returns `{ok, error?}`; non-POST 405. Keeper `state` and `pair` go to `hub.emit(..., {store:false})`; `attachOwner` sends the current state; keeper starts on listen, stops on close; `pairing.mine` only in the window holding the pairing client.

## Web

- `web/src/remote/{slice,RemoteButton,api,RemoteView}.tsx`: slice `{supported (hello.protocol >= 20), state, pair}`; `indicator(state)`: off when `!configured || !enabled`; trouble when `lastError || startFailed`; online when `online`; else connecting. Tab kind `remote` (`openRemote`, `ICONS.remote`, labels in `TabStrip`/`TabsMenu`, `Panes.tsx`).
- Header button `#remoteBtn` before `usageBtn`, dot `data-state`, count of online devices when online, tooltip in words plus `lastError.message`; only when `supported`.
- Remote tab sections: Access (switch, disabled with a note when `legacy`; relay text with Edit/Save; host fingerprint; no relay: field, Save and a guide link), Pair a phone (button, server's SVG QR, `uri` with Copy, fingerprint, minutes left, Cancel; outcomes in place; "pairing in another window" when `pairing && !pairing.mine`), Phones (name, fingerprint, online, paired date, inline Revoke confirm). An old server's pane says it is too old.

## Review focus

- Two windows starting together: one connector. Off stops a hand-started one. 4402 gives a red state with the reason, no respawn loop. Protocol 19 page: no indicator, no tab.

Docs: `docs/guide.md`, `CHANGELOG.md`. Checks: `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e` (serialised). Smoke on 4790 with a temp home and a local `testRelay` on 4791: save the relay, dot goes green, Pair shows a QR, off stops the connector.
