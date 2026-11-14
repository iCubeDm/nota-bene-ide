# Relay access keys (issue 371)

## Intent

The relay admits any host that proves its own key, and a host makes that key itself. Anyone who learns the relay's
address can use it, and the operator can neither tell users apart nor shut one out. Wanted: the operator gives each
tester a personal access key; every host connection is signed with it and the relay checks the signature; one key admits
at most a set number of hosts at once (3 by default); revoking the key drops that person's hosts at once.

Later, account management issues keys instead of an operator command. The relay keeps the same model then: a key and the
number of hosts it may connect. This change builds that model with a file as the source.

## Goals

- A relay started with a members file admits a host only when its hello carries a member key in that file and a valid
  signature by that key over this connection's challenge.
- One member key: at most `hosts` hosts connected at once (default 3). Reconnects of an already connected host id don't
  count twice.
- `nb-relay invite <name>` makes a key, records it and prints the code once. `nb-relay revoke <name>` removes it; a
  running relay notices within seconds and closes that member's hosts. `nb-relay members` lists names and limits.
- The window's Remote tab takes the code (a field like a password), shows whether one is set, and explains a refusal: no
  key, key revoked or unknown, too many computers on this key. `nota-bene remote` takes it from the terminal too.

## Non-goals

- Accounts, sign-up, billing, a web admin page. The relay stays one process with a file.
- Changing phones: the device hello, the app and pairing stay as they are. A phone only reaches a host that lists it,
  so closing the door to hosts is enough.
- Several relays sharing one members list.

## Anti-goals

- The relay storing anything that lets someone in: the members file holds only public keys.
- A code in a log, a URL, an error message or the page's state. The page only learns "a key is set".
- An existing setup broken without a clear message: an old connector meeting a keyed relay sees "the relay does not admit
  this host", and the tab says an access key is needed.

## Approaches

- **1. A personal Ed25519 key; the relay keeps only public halves (chosen by the user).** The code is the private seed.
  The host signs every connection's challenge with it; the relay checks against its file. Revocation is a line removed.
  No database; one new field pair in the host hello.
- 2. A pass signed by an operator master key (like a JWT). Stateless for several relays, but revocation still needs a
  list, a pass can be forwarded, and it signs no connection unless a second key is added (which is approach 1).
- 3. A one-time invite code bound to the first host that uses it. The relay must keep state, and a second computer of the
  same person needs a new code.

Decided with the user: one key per person, limit 3 hosts at once.

## Design

### Key and code

- A member key is an Ed25519 key pair. The code is `nbk1_` followed by base64url (no padding) of the 32-byte seed: 48
  characters. The prefix lets the window and CLI recognise a code and refuse a pasted phone pairing URI or host id.
- The member's id on the relay is base64url of the 32-byte public key (43 characters).

### Wire (relay protocol, still version 1; the additions are optional fields)

Host hello adds, when the host has a key:

- `"member": <32 B public key>`
- `"sig": <64 B>` = Ed25519 signature by the member key over the ASCII string `"nb-relay-v1 member"` followed by the 32
  raw bytes of `nonce`, the 32 raw bytes of `eph` and the 32 raw bytes of the host's `key`.

The signature binds the access key to this challenge and this host key: it can't be replayed on another connection or
lent to another host id. A device hello never carries these fields; a relay ignores them there.

A relay without a members file ignores both fields (as today, unknown fields are ignored), so a new connector works with
an old or open relay. A relay with a members file:

- no `member`, malformed `member`/`sig`, unknown key, or bad signature: close **4402** (not admitted; don't retry
  unchanged). The existing host-key proof is checked first, so 4401 still means the host key proof failed.
- key known, but `hosts` other host ids already connected with it: close **4405** (new): the access key's host limit is
  reached. Retry with backoff: another of the member's hosts may leave.
- admitted: as today. A host replacing a connected host with the same host id (4409 to the old one) is a reconnect and
  does not need a free slot.
- the key is revoked while hosts are connected: the relay closes them with 4402.
- its limit is lowered below the count: the relay closes the most recently admitted hosts over the limit with 4405
  (the key is still valid; they retry with backoff and come back when a slot frees). A 4405 can thus arrive after `ok`.
- a host id already connected under another member key (its user saved a new key) is a reconnect only when the key
  matches; otherwise it needs a free slot under the new key, and its slot under the old one is freed.

PROTOCOL.md documents the fields, the signed message, a worked example with fixed test keys (like the existing one), the
new code, and that 4405 retries with backoff.

### Hub (`relay/hub`)

- The `Admit` hook changes from `Admit(ctx, hostID) bool` to one that also receives the proven member key (or none) and
  answers "refused" or "admitted, at most N hosts for this key". The hub counts connected host ids per member key and
  enforces N. The hub verifies the signature itself before calling the hook, so the hook never handles signatures.
- The hub gets a way to drop a member's hosts (revocation) and to re-apply a lowered limit, so a file watcher — or later
  an account service — can call it. An embedding program (the future paid relay) implements the same hook from its
  account store.
- Logging stays counts and close codes only; it never names a member and never logs a key.

### Relay program (`relay/cmd/nb-relay`)

- New flag `-members <file>`. Without it the relay is open, as today (local runs, tests, self-hosters who don't want
  keys). With it, the file is required to exist and parse at start; the relay re-reads it when its modification time
  changes (checked every 2 s) and applies removals and limit changes to connected hosts. A file that fails to parse on
  re-read is logged as an error and the previous list is kept.
- Members file: JSON, written atomically (temp file + rename), mode 0600, owned by the relay's user:
  `{"members":[{"name":"alice","key":"<43 chars>","hosts":3,"added":"2026-11-14"}]}`. Names are unique, 1–40
  characters of letters, digits, `-`, `_`, `.`.
- Subcommands (same binary, operate on the file only; the running relay picks the change up):
  - `nb-relay invite -members <file> [-hosts N] <name>`: refuses an existing name; prints the code once on stdout with
    one line of instructions. The private seed is not stored anywhere.
  - `nb-relay revoke -members <file> <name>`.
  - `nb-relay members -members <file>`: name, limit, date added; never keys.
  - `nb-relay limit -members <file> <name> <N>`: change a member's host limit.
- The container image's ENTRYPOINT passes server flags, so the README shows the subcommands run with
  `--entrypoint /nb-relay`, and keeping the members file owned by the image's `nonroot` user (65532).
- README: running with `-members`, the systemd and container usage (a volume or bind mount for the file), and the order
  to switch a live relay over (below).

### Host connector (`server/src/remote/`)

- The code is kept in `remote/access-key` (0600, written like the other private files, `writePrivateFile`), only the
  seed. Reading it validates the format; a bad file is reported like the other private files.
- `relayClient.ts` adds `member` and `sig` to the hello when a key is set. Close 4405 is not fatal, at hello or after
  `ok`: back off and retry, record it in `last-error.json` while retrying (cleared once online, as today), so the window
  can explain it. 4402's message becomes: the relay does not admit
  this host — the access key is missing, unknown or revoked.
- `nota-bene remote key` reads a code from stdin (prompt, no echo when a terminal) and saves it; `nota-bene remote key
  --clear` removes it. A running connector picks the change up on its next connection; the window's path below restarts
  it so the change applies now.

### Window (server routes, protocol, web)

- `RemoteState` gains `accessKey: boolean` (a key is saved). `lastError` already carries 4402; 4405 appears there too
  while the connector retries. This is a protocol change: version 21, generated Dart and schema updated.
- `POST /remote/config` accepts `accessKey: string` (validated `nbk1_…` format, trimmed) or `accessKey: null` (clear).
  Saving or clearing a key restarts a managed connector, or a hand-started one through the control socket's `stop` as
  the access switch does today, so it reconnects with the new key. A legacy (versionless) hand-started connector: 409
  `legacy`, as for the other settings.
- Remote tab: an **Access key** row under the relay address: a password-style field and Save while none is set; "set"
  and a Change / Remove pair once one is. Errors in the tab and the header tooltip:
  - 4402: "The relay does not admit this computer: enter the access key you were given, or ask for a new one."
  - 4405: "This access key is already used on the most computers allowed. Close Nota Bene on another computer, or ask
    for a higher limit."
  All new strings in all six languages.
- `docs/guide.md` Remote access: where the key comes from, entering it, what the two errors mean.

### Switching the live relay over

1. Release a Nota Bene with this change; every user updates.
2. The operator invites each person (themselves first) and sends the code privately; each enters it in the Remote tab.
   The relay still runs open, ignores the key, and everything keeps working.
3. The operator restarts the relay with `-members`. Anyone without a key now gets 4402 and the tab says why.

## Calls made while writing this up (not discussed with the user)

- Code format `nbk1_` + seed; members file as JSON with re-read every 2 s; subcommands in the same binary.
- No key on an open relay is fine; `-members` is opt-in, the live droplet turns it on.
- A lowered limit closes with 4405, not 4402 (the person's key still works).
- Revocation and limits apply to connected hosts at once, not only at the next connection.

## Left to the builder

- The exact hook and method names in `relay/hub`, and how the watcher calls the hub.
- The Ed25519 libraries: Go's standard `crypto/ed25519`; Node's `crypto` (`createPrivateKey` from a raw seed via
  PKCS#8 DER wrapping, `sign(null, …)`).
- Whether `members` also shows how many hosts each member has connected (needs a query of the running relay; not
  required).
