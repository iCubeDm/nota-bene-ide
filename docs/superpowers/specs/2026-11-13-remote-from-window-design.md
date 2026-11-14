# Remote access from the window (issue 369)

## Intent

The laptop is the main host; the phone takes over when the laptop is charging and the user is out. Today the phone's
access needs `nota-bene remote` running in a terminal, and no window shows whether it runs. Wanted: access that is just
there while windows are open, its state visible at a glance, and everything the terminal commands do reachable from a
window.

Not this change: a desktop computer as a client of another host (issue 297, deferred: e.g. a Mac working on a Windows
host). Remote stays "the phone".

## Goals

- The first window starts the connector in the background; the others find and reuse it. A connector the user started by
  hand in a terminal is reused the same way.
- A header indicator shows the relay connection state. A click opens a **Remote** tab.
- The Remote tab does what the terminal does: set the relay address, turn access on and off, pair a phone (QR in the
  tab), list the paired phones with their online state, revoke one.
- Closing or restarting any window, the first one included, does not cut the phone off while another window is open.

## Non-goals

- Changing the relay protocol, the Noise channel, pairing cryptography or the phone app.
- A desktop client (297). Push notifications. Several relays at once.
- Removing the terminal commands: `nota-bene remote`, `pair`, `devices`, `revoke`, `status` keep working.

## Anti-goals

- A window that silently starts a second connector next to a running one (the control socket stays the single-instance
  lock).
- The phone losing access because the window that happened to start the connector was closed.
- Pairing a phone without the user seeing the code and the fingerprints, as `pair` shows them today.

## Approaches

- **A. A background process, like the Whisper host (chosen by the user).** The first window spawns `nota-bene remote`
  detached; every window talks to it over the existing control socket and serves the page what it needs. Survives any
  window's close; a hand-started connector is reused. Cost: spawn lock, log, stop after the last window. The Whisper
  host (`server/src/dictation/hostClient.ts`) already solves these, and the pattern is copied.
- **B. The connection inside the first window's server.** Less code at first, but closing or restarting that window
  drops the phone, and handing the connection to another window rebuilds A in a harder form.
- **C. The launcher holds the connection.** There is one launcher per window, not per user: same problem as B.

## Design

### When the connector runs

- **Condition:** a relay address is saved (`<stateBase>/remote/config.json`) and access is not turned off. Paired phones
  are not required: with no paired phone and no pairing code the relay admits nobody, so the connection exposes
  nothing, and pairing from the tab needs the connector running.
- **Off switch:** `config.json` gains `"enabled": false` (absent means on). Turning access off stops the connector and
  keeps windows from starting it again; turning it on starts it. The relay address and the paired phones stay.
- **Start (`ensure`)**: every window, on start and then every 5 s, asks the control socket for `status`. No answer and
  the condition holds: it takes `<stateBase>/remote/spawn.lock` (same rules as the Whisper host's lock: a stale lock is
  taken over) and spawns the connector detached, `nota-bene remote --managed`, output in `remote/connector.log`
  (`connector.log.1` keeps the previous start). It then waits for the socket to answer. Windows that find nobody at the
  same moment start one between them. A connector that crashed is started again by the next poll of any window.
- **Stop:** a `--managed` connector exits after 60 s with no live window (it already discovers the windows it serves,
  `server/src/remote/discover.ts`), so a window restart within a minute does not drop the phone. A connector started by
  hand (no `--managed`) never exits on its own, as today; the off switch asks it to stop over the control socket (new op
  `stop`).

### What a window serves the page

New routes, all key tier (the auth default), in `server/src/remote/` beside the rest:

- `GET /remote` → `{ configured, enabled, running, online, relay, hostFingerprint, devices: [{id, name, fingerprint,
  online, pairedAt}], pairing: null | {expiresAt} }`. `running`: the control socket answers; `online`: the connector is
  connected to the relay.
- `POST /remote/config {relay?, enabled?}` → saves `config.json`, then starts or stops the connector as above. A relay
  address is checked as the CLI checks it (`checkRelay`). Changing the relay of a running connector restarts it.
- `POST /remote/pair` → starts a pairing over the control socket and answers `{ uri, qr: <svg>, hostFingerprint,
  expiresAt }`; the QR is rendered on the server with `uqr` (already a server dependency), so the web adds no library.
  The window keeps the control client open for the pairing's life, as `pair` does.
- `POST /remote/pair/cancel`, `POST /remote/revoke {id}`.

The state reaches the page as a server event, so the indicator needs no polling of its own: `remote {state}` (the `GET
/remote` shape) is sent to every socket of the window when it changes (the 5 s poll of `ensure` is the source) and on
attach. Pairing outcomes arrive the same way: `remote-pair {result: 'paired' | 'refused' | 'expired' | 'cancelled',
device?, fingerprint?}`. This is a new protocol number; the page shows neither indicator nor tab for an older server.

### Header indicator

Beside the usage button, a small icon with a dot, its tooltip naming the state:

- off (no relay saved, or turned off): muted icon, no dot;
- connecting (running, not yet online, or being started): amber dot;
- online: green dot, and the number of phones connected when there are any;
- trouble (the condition holds but the connector does not run after a start attempt, or the relay refused the host):
  red dot, tooltip with the reason (`lastError`) or "not running, see `remote/connector.log`".

Click opens the Remote tab (as the usage button opens Usage).

### Remote tab

One tab kind `remote` (as `usage`), one page, top to bottom:

1. **Access**: on/off switch, the state in words (the indicator's), the relay address with Edit, the host fingerprint.
   With no relay saved, the address field and Save are all there is, with a line on what a relay is and a link to the
   guide.
2. **Pair a phone**: a button; it shows the QR, the `nbremote://` text with Copy, the host fingerprint ("the app shows
   it too, they must match"), the time left, and Cancel. Paired: the phone's name and fingerprint, then the list
   refreshes. Refused or expired: said in place, with Pair again.
3. **Phones**: name, fingerprint, online/offline, paired date, Revoke (inline confirmation, as other destructive actions
   in the app).

Every string in all six languages.

### Decisions settled after review (the author's calls, marked for the user to check)

- **The phone cannot reach `/remote/*`.** A paired phone's requests reach a window with the helper bearer, which opens
  both tiers, so without a filter a phone could pair another device unseen, revoke phones or turn access off. The
  connector refuses `/remote` and `/remote/...` from a phone the way it refuses `/control` (`server/src/remote/device.ts`,
  with a test). Pairing or revoking from a linked device (epic 63) is a later feature with its own announcements.
- **A hand-started connector.** Running `nota-bene remote` in a terminal is an explicit request: it sets `enabled` back
  on (as `--relay` saves the address). The tab's off switch stops it too (the `stop` op), and a relay change in the tab
  stops it and lets a managed one take over; the tab says that the terminal's connector was stopped.
- **The relay refuses the host for good** (4401, 4402, 4409, 4413: the connector exits 1). The connector writes the
  reason to `remote/last-error.json` `{code, message, at}` before it exits; `GET /remote` carries it as `lastError`, the
  indicator is red and the tab shows the reason in words. Windows back off: after a failed start the next attempt waits
  1, 2, 5, then 10 minutes; a change in the tab (relay, on) starts at once and clears the back-off and the error.
- **An older connector after an upgrade.** `status` gains `version` (the package version) and `managed`. A managed
  connector of another version is stopped with `stop` and replaced. One that answers without `version` predates this
  change and was started by hand (no managed ones existed): it is reused, and the tab says "started in a terminal by an
  older version; restart it there to use the switches", with the switches disabled.
- **Pairing across windows:** only the window that started a pairing shows its QR and outcome; the others show "a
  pairing is in progress" (`status` gains `pairing: {expiresAt}` on the connector side). `pairedAt` is the stored
  `addedAt`. The connector is spawned like the Whisper host: the package's remote entry with `process.execPath`.

## Left to the builder

- Exact component names and placement in `web/src` (follow Usage), icon choice.
- The managed connector's idle check interval and log rotation details (copy the Whisper host).
- Windows: the control socket is a named pipe with a secret handshake; `ensure` and the spawn must go through the same
  helpers as the CLI (`controlClient`), so nothing platform-specific is new.
- Tests: the `ensure` race (two windows, one connector), stop after the last window, the off switch against a managed and a
  hand-started connector, the routes' tiers, the pairing outcomes; web: indicator states, tab sections, gating on the
  protocol.
