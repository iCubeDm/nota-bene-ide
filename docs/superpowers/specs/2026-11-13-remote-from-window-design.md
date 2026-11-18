# Remote access from the window (issue 369)

## Intent

The laptop is the main host; the phone takes over when the laptop is charging and the user is out. Today phone access needs `nota-bene remote` in a terminal and no window shows whether it runs. Wanted: access that is just there while windows are open, its state visible at a glance, and everything the terminal commands do reachable from a window. Not this change: a desktop computer as a client of another host (issue 297, deferred); remote stays "the phone".

## Goals

- The first window starts the connector in the background; others find and reuse it (a hand-started connector too).
- A header indicator shows the relay connection state; click opens a **Remote** tab.
- The tab does what the terminal does: set relay address, turn access on/off, pair a phone (QR in the tab), list paired phones with online state, revoke one.
- Closing or restarting any window, the first included, does not cut the phone off while another window is open.

Non-goals: changing the relay protocol, Noise channel, pairing cryptography or the phone app; a desktop client (297); push; several relays; removing terminal commands (`nota-bene remote`, `pair`, `devices`, `revoke`, `status` keep working).

Anti-goals: a window silently starting a second connector (the control socket stays the single-instance lock); the phone losing access because the starter window closed; pairing without the user seeing the code and fingerprints.

## Approaches

- **A. Background process like the Whisper host (chosen by the user).** The first window spawns `nota-bene remote` detached; every window talks to it over the existing control socket. Survives any window's close; a hand-started connector is reused. Cost: spawn lock, log, stop after the last window; `server/src/dictation/hostClient.ts` already solves these and the pattern is copied.
- B. Connection inside the first window's server: closing/restarting that window drops the phone; handing over rebuilds A harder.
- C. Launcher holds the connection: one launcher per window, not per user; same problem as B.

## Design

### When the connector runs

- Condition: a relay address is saved (`<stateBase>/remote/config.json`) and access is not off. Paired phones are not required: with no phone and no pairing code the relay admits nobody, and pairing from the tab needs the connector running.
- Off switch: `config.json` gets `"enabled": false` (absent = on). Off stops the connector and keeps windows from starting it; on starts it. Relay address and paired phones stay.
- `ensure`: every window, on start and every 5 s, asks the control socket for `status`. No answer and the condition holds: take `<stateBase>/remote/spawn.lock` (Whisper host lock rules, stale lock taken over), spawn `nota-bene remote --managed` detached, output in `remote/connector.log` (`connector.log.1` keeps the previous start), then wait for the socket. Windows racing share one start; a crashed connector is restarted by the next poll.
- Stop: a `--managed` connector exits after 60 s with no live window (it discovers windows via `server/src/remote/discover.ts`), so a restart within a minute keeps the phone. A hand-started one (no `--managed`) never exits on its own; the off switch stops it via a new control op `stop`.

### What a window serves the page

New routes, key tier, in `server/src/remote/`:
- `GET /remote` -> `{ configured, enabled, running, online, relay, hostFingerprint, devices: [{id, name, fingerprint, online, pairedAt}], pairing: null | {expiresAt} }` (`running` = control socket answers; `online` = connected to the relay).
- `POST /remote/config {relay?, enabled?}`: saves `config.json`, starts/stops the connector; relay checked by `checkRelay`; changing the relay of a running connector restarts it.
- `POST /remote/pair` -> `{ uri, qr: <svg>, hostFingerprint, expiresAt }`; QR rendered server-side with `uqr` (existing dependency, no web library); the window keeps the control client open for the pairing's life as `pair` does.
- `POST /remote/pair/cancel`, `POST /remote/revoke {id}`.

State reaches the page as a server event (no indicator polling): `remote {state}` (the `GET /remote` shape) goes to every socket of the window on change (source: the 5 s `ensure` poll) and on attach. Pairing outcomes: `remote-pair {result: 'paired'|'refused'|'expired'|'cancelled', device?, fingerprint?}`. New protocol number; the page shows neither indicator nor tab for an older server.

### Header indicator

Beside the usage button, an icon with a dot and a tooltip naming the state: off (no relay or turned off): muted, no dot; connecting (running not yet online, or being started): amber; online: green plus connected-phone count; trouble (does not run after a start attempt, or relay refused the host): red, tooltip with `lastError` or "not running, see `remote/connector.log`". Click opens the Remote tab.

### Remote tab

One tab kind `remote` (like `usage`): (1) **Access**: on/off switch, state in words, relay address with Edit, host fingerprint; with no relay, only address field and Save plus a line on what a relay is and a guide link. (2) **Pair a phone**: button; shows QR, `nbremote://` text with Copy, host fingerprint ("the app shows it too, they must match"), time left, Cancel; paired: name and fingerprint, list refreshes; refused/expired said in place with Pair again. (3) **Phones**: name, fingerprint, online/offline, paired date, Revoke (inline confirmation). All strings in six languages.

### Decisions settled after review (author's calls, for the user to check)

- The phone cannot reach `/remote/*`: a paired phone's requests carry the helper bearer, which opens both tiers, so without a filter a phone could pair another device, revoke phones or turn access off. The connector refuses `/remote` and `/remote/...` from a phone as it refuses `/control` (`server/src/remote/device.ts`, tested). Pairing/revoking from a linked device (epic 63) is later with its own announcements.
- A hand-started connector: running `nota-bene remote` sets `enabled` back on (as `--relay` saves the address). The tab's off switch stops it too (`stop`); a relay change in the tab stops it and lets a managed one take over; the tab says the terminal's connector was stopped.
- Relay refuses the host for good (4401, 4402, 4409, 4413: connector exits 1): it writes `remote/last-error.json` `{code, message, at}` first; `GET /remote` carries `lastError`; indicator red, tab shows the reason. Windows back off after a failed start: 1, 2, 5, then 10 min; a tab change (relay, on) starts at once and clears back-off and error.
- Older connector after an upgrade: `status` gains `version` and `managed`. A managed connector of an older version is stopped with `stop` and replaced (only older, so a still-open previous-release window does not replace the new one back). One answering without `version` predates this and was hand-started: reused, tab says "started in a terminal by an older version; restart it there to use the switches", switches disabled.
- Pairing across windows: only the starting window shows the QR and outcome; others show "a pairing is in progress" (`status` gains `pairing: {expiresAt}`). `pairedAt` is the stored `addedAt`. The connector is spawned like the Whisper host: the package's remote entry with `process.execPath`.

## Left to the builder

Component names and placement in `web/src` (follow Usage), icon; idle check interval and log rotation (copy Whisper host); Windows (control socket is a named pipe with a secret handshake): `ensure` and spawn go through the same helpers as the CLI (`controlClient`), so nothing platform-specific is new; tests: `ensure` race (two windows, one connector), stop after the last window, off switch against managed and hand-started connectors, route tiers, pairing outcomes; web: indicator states, tab sections, protocol gating.
