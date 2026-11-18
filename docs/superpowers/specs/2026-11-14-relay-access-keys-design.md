# Relay access keys (issue 371)

## Intent

The relay admits any host proving its own key, and a host makes that key itself: anyone knowing the relay's address can use it, and the operator can neither tell users apart nor shut one out. Wanted: the operator gives each tester a personal access key; every host connection is signed with it and checked by the relay; one key admits at most a set number of hosts at once (3 default); revoking drops that person's hosts at once. Later, account management issues keys; the relay keeps the same model (a key and its host limit). This builds that model with a file as source.

## Goals

- A relay started with a members file admits a host only when its hello carries a member key in the file and a valid signature by that key over this connection's challenge.
- One key: at most `hosts` hosts at once (default 3); reconnects of an already connected host id do not count twice.
- `nb-relay invite <name>` makes a key, records it, prints the code once; `revoke <name>` removes it (a running relay notices within seconds and closes that member's hosts); `members` lists names and limits.
- The window's Remote tab takes the code (password-style field), shows whether one is set, and explains refusals (no key, revoked/unknown, too many computers); `nota-bene remote` takes it from the terminal too.

Non-goals: accounts, sign-up, billing, admin page (the relay stays one process with a file); changing phones (device hello, app, pairing unchanged; a phone only reaches a host that lists it, so closing the door to hosts is enough); several relays sharing one list.

Anti-goals: the relay storing anything that lets someone in (the file holds only public keys); a code in a log, URL, error or page state (the page learns only "a key is set"); breaking an existing setup without a clear message (an old connector meeting a keyed relay sees "the relay does not admit this host" and the tab says a key is needed).

## Approaches

- **1. Personal Ed25519 key; the relay keeps only public halves (chosen by the user).** The code is the private seed; the host signs every connection's challenge; the relay checks against its file; revocation is a removed line; no database; one new field pair in the host hello.
- 2. A pass signed by an operator master key (JWT-like): stateless across relays, but revocation still needs a list, a pass can be forwarded, and it signs no connection unless a second key is added (which is approach 1).
- 3. One-time invite bound to the first host using it: the relay must keep state and a second computer needs a new code.

Decided with the user: one key per person, limit 3 hosts at once.

## Design

### Key and code

Ed25519 key pair. Code = `nbk1_` + base64url (no padding) of the 32-byte seed (48 chars); the prefix lets the window/CLI recognise a code and refuse a pasted phone pairing URI or host id. The member's id on the relay is base64url of the 32-byte public key (43 chars).

### Wire (relay protocol still version 1; optional fields)

Host hello adds, when the host has a key: `"member"` (32 B public key) and `"sig"` (64 B) = Ed25519 signature over ASCII `"nb-relay-v1 member"` + 32 raw bytes of `nonce` + 32 of `eph` + 32 of the host's `key`. It binds the key to this challenge and host key (no replay, not lendable to another host id). A device hello never carries them; the relay ignores them there.

A relay without a members file ignores both fields (new connector works with an old or open relay). With one:
- no `member`, malformed `member`/`sig`, unknown key or bad signature: close **4402** (not admitted; do not retry unchanged). The host-key proof is checked first, so 4401 still means that failed.
- key known but `hosts` other host ids already connected: close **4405** (new, host limit reached); retry with backoff.
- admitted: as today; a host replacing one with the same host id (4409 to the old) is a reconnect and needs no free slot.
- key revoked while connected: close with 4402. Limit lowered below the count: close the most recently admitted hosts over the limit with 4405 (key still valid; they retry and return when a slot frees), so 4405 can arrive after `ok`.
- a host id connected under another member key (new key saved) is a reconnect only when the key matches; otherwise it needs a free slot under the new key and frees its old slot.

PROTOCOL.md documents the fields, signed message, a worked example with fixed test keys, the code, and that 4405 retries with backoff.

### Hub (`relay/hub`)

- The `Admit` hook changes from `Admit(ctx, hostID) bool` to one that also receives the proven member key (or none) and answers "refused" or "admitted, at most N hosts for this key". The hub counts host ids per key, enforces N, and verifies the signature itself before calling the hook.
- The hub can drop a member's hosts and re-apply a lowered limit, callable by a file watcher or a future account service; an embedding program (future paid relay) implements the same hook from its account store.
- Logs stay counts and close codes; never a member name or key.

### Relay program (`relay/cmd/nb-relay`)

- Flag `-members <file>`; without it the relay is open (local runs, tests, self-hosters). With it, the file must exist and parse at start; re-read when mtime changes (checked every 2 s), applying removals and limit changes to connected hosts; a re-read parse failure is logged and the previous list kept.
- File: JSON, atomic write (temp + rename), 0600, owned by the relay user: `{"members":[{"name":"alice","key":"<43 chars>","hosts":3,"added":"2026-11-14"}]}`; names unique, 1–40 chars of letters, digits, `-`, `_`, `.`.
- Subcommands (same binary, operate on the file only): `invite -members <file> [-hosts N] <name>` (refuses an existing name; prints the code once with one line of instructions; the seed is stored nowhere); `revoke`; `members` (name, limit, date; never keys); `limit <name> <N>`.
- The container ENTRYPOINT passes server flags, so README shows subcommands via `--entrypoint /nb-relay` with the file owned by `nonroot` (65532); README also covers running with `-members`, systemd/container use (volume or bind mount) and the switch-over order.

### Host connector (`server/src/remote/`)

- The code lives in `remote/access-key` (0600, `writePrivateFile`), seed only; reading validates the format.
- `relayClient.ts` adds `member` and `sig` when a key is set. 4405 is not fatal (hello or after `ok`): back off, retry, record in `last-error.json` while retrying (cleared once online). 4402 message: the relay does not admit this host: its operator refused it (no key, unknown or revoked).
- `nota-bene remote key` reads a code from stdin (no echo on a terminal) and saves it; `--clear` removes it. A running connector picks it up on its next connection; the window's path restarts it so it applies now.

### Window (routes, protocol, web)

- `RemoteState` gains `accessKey: boolean`; `lastError` carries 4402 and 4405. Protocol version 21; generated Dart and schema updated.
- `POST /remote/config` accepts `accessKey: string` (validated `nbk1_…`, trimmed) or `null` (clear). Saving/clearing restarts a managed connector, or a hand-started one via control `stop`, as the access switch does; a legacy versionless one gets 409 `legacy`.
- Remote tab: an **Access key** row under the relay address: password-style field and Save while unset; "set" with Change/Remove once set. Errors in tab and header tooltip: 4402 "The relay does not admit this computer: enter the access key you were given (if it was revoked, ask for a new one)."; 4405 "This access key is already used on the most computers allowed. Close Nota Bene on another computer, or ask for a higher limit." Six languages. `docs/guide.md` Remote access covers where the key comes from, entering it, the two errors.

### Header: Remote and Usage move into the settings menu (asked by the user)

- The header loses Remote and Usage buttons. The gear menu gets two rows above "All settings": **Remote access** with state on the right (off / connecting / online · N phones / not working) opening the Remote tab; **Usage** opening the Usage tab.
- The gear carries the access state as a dot while access is on and a relay is saved: green online (user's ask) and, my call so trouble is not hidden, yellow connecting, red not working; no dot when off, unconfigured or server older than protocol 20.
- `RemoteButton` becomes the menu row plus the gear's dot; ids `remoteMenu`, `usageMenu` replace `remoteBtn`, `usageBtn` (tests move with them).

### Switching the live relay over

1. Release a version with this change; users update. 2. The operator invites each person (themselves first), sends codes privately; each enters it in the Remote tab (the open relay ignores the key, so all keeps working). 3. The operator restarts the relay with `-members`; anyone without a key gets 4402 and the tab says why.

## Calls made while writing (not discussed with the user)

`nbk1_` + seed code; JSON members file re-read every 2 s; subcommands in the same binary; no key on an open relay is fine, `-members` is opt-in; a lowered limit closes with 4405 not 4402; gear dot also yellow/red; revocation and limits apply to connected hosts at once.

## Left to the builder

Hook and method names in `relay/hub` and how the watcher calls the hub; Ed25519 libraries (Go `crypto/ed25519`; Node `crypto` with `createPrivateKey` from a raw seed via PKCS#8 DER wrapping, `sign(null, …)`); whether `members` also shows connected-host counts (not required).
