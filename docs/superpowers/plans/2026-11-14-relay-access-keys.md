# Relay access keys: implementation plan

**Goal:** A relay started with `-members` admits only hosts whose hello is signed by a member's Ed25519 key, at most N hosts per key, with live revocation; the host and the window carry the key; Remote and Usage move into the settings menu.

**Approach:** The hub verifies an optional `member`/`sig` pair in the host hello and asks the `Admit` hook for that key's host limit; it counts hosts per member and exposes `Revoke`/`Limit`. `nb-relay` implements the hook from a JSON members file re-read every 2 s, and gains `invite`/`revoke`/`members`/`limit` subcommands. The connector reads `remote/access-key` on every connection; the window saves it through `POST /remote/config` and shows `accessKey: boolean` (protocol 20 to 21).

**Spec:** `docs/superpowers/specs/2026-11-14-relay-access-keys-design.md`. Commit prefix `gh-371`.

## Decisions and contracts

- Tests and smoke use ports 4790-4795 and a temporary `NOTA_BENE_HOME`; never probe a live window or `~/.nota-bene`. No code, seed or member key in logs, errors, URLs or page state; relay logs stay counts and close codes. Neutral fixtures (`alice`, `relay.example.com`). All new UI text in all six `LANGS`.
- Code format `nbk1_` + base64url(32-byte seed), 48 characters; member id = base64url(public key), 43 characters. Signed message: ASCII `nb-relay-v1 member` || nonce(32) || eph(32) || host key(32).
- New close code 4405: the key's host limit is reached (at hello, or after `ok` when a limit is lowered); the host retries with backoff. 4402 wording: "no or unknown access key". Default limit 3 hosts per key.
- Members file: `{"members":[{"name","key","hosts","added"}]}`, mode 0600, atomic writes (temp file in the same dir, rename), re-read every 2 s on mtime/size change; a bad re-read keeps the old list and logs an error; a missing or bad file at start exits non-zero. Names `^[A-Za-z0-9._-]{1,40}$`. The file holds only the public half.

### Hub (`relay/hub/{auth,hub,server}.go`)

- `MemberSign(seed, nonce, eph, hostKey) []byte`, `VerifyMember(pub, nonce, eph, hostKey, sig) bool`.
- `Options.Admit(ctx, hostID, member *[32]byte) (hosts int, ok bool)`; `member` nil when the hello has none; `hosts <= 0` means no per-key limit. With no hook the hub ignores `member`/`sig` entirely (an open relay with a malformed member still admits). With a hook: missing, malformed or badly signed member is refused 4402.
- `Server.Revoke(member)` closes that member's hosts with 4402; `Server.Limit(member, hosts)` closes the most recently admitted hosts above the limit with 4405. Both pick hosts under `s.mu`, then `closeWith` + `shutdown` outside the lock, like `register` does for a replaced host.
- `register` counts other host ids with the same member (a reconnect with the same id and key is a replacement and not counted, so it is admitted while at the limit; the old one gets 4409); a host id moving to another key frees its slot under the old key; 4405 is distinct from 4429.

### `nb-relay` (`relay/cmd/nb-relay/members.go`, `main.go`)

- `nb-relay invite|revoke|members|limit -members FILE ...` dispatched before the server flags; server flag `-members FILE`. `invite alice` prints one code once; duplicates and bad names are refused; `members` lists without keys. A watcher diffs old and new: removed key gives `Revoke`, lowered `hosts` gives `Limit`; the tick is injectable for tests.
- Docs: `relay/PROTOCOL.md` (member fields, signed message, example row from seed 0x41..0x60, 4405 and retry rules), `relay/README.md` (`-members`, subcommands, systemd and container usage with `--entrypoint /nb-relay` and the file owned by uid 65532, the three-step switch-over from the spec).

### Host connector (`server/src/remote/`)

- store: `parseAccessKey(code)` returns the seed (error "an access key starts with nbk1_ and has 48 characters", with a distinct phone-code message when the input looks like `nbremote://`); `readAccessKey`, `writeAccessKey(code|null)` (file `remote/access-key`, 0600), `memberSign`, `memberPub`. Implemented with `node:crypto`: PKCS#8 DER prefix `302e020100300506032b657004220420` for the seed, `sign(null, msg, key)`, public key from the JWK `x`. `memberSign` must equal the protocol example's signature (same vector as the Go test).
- RelayClient option `member: () => Buffer | null` read per connection; the hello carries `member` and `sig` only when a seed exists. A 4405 close is not fatal: reconnects with backoff and emits `limited`. FATAL[4402] = "the relay does not admit this host: the access key is missing, unknown or revoked".
- Connector control op `reconnect`: drops the socket and reconnects now with backoff reset. On `limited`: last-error `{code: 4405, message: 'this access key is already used on the most computers allowed'}`, cleared on online.
- CLI: `nota-bene remote key` (one line from stdin, no echo on a TTY, prints "saved"), `nota-bene remote key --clear`; `REMOTE_USAGE` lists them. `testRelay.ts` records `member`/`sig` and can close with a given code.

### Window and web

- `RemoteState.accessKey: boolean` (never the code); `PROTOCOL = 21` with a history line; `keeper.setConfig(c & {accessKey?: string | null})`; `POST /remote/config` accepts `accessKey` (400 on bad format with the store's message, 409 `legacy` for a versionless connector). Saving a key tells a running connector to `reconnect`, and starts one at once if it exited on 4402 (not after backoff); `null` removes the file. Protocol regenerated (`npm run gen:protocol`), fixtures and dart test bumped (a `remote` fixture with `accessKey`).
- Web (`web/src/remote/{RemoteView,RemoteButton,api}.tsx`, `web/src/shell/Header.tsx`, i18n): header loses `#remoteBtn`/`#usageBtn`; the settings menu gains `#remoteMenu` (state text, e.g. online, 2) and `#usageMenu` above the separator before "All settings"; `#settingsDot` (data-state online/connecting/trouble; absent when off or protocol 19) sits on the gear. Remote tab: `#remoteAccessKey` password field and Save (400 shows the reason); when set, "set" with Change/Remove (Remove posts `{accessKey:null}`); lastError 4402 shows "enter the access key", 4405 "most computers allowed", also in the menu row's tooltip. `e2e/usage.spec.ts` opens the settings menu then `#usageMenu`.

## Review focus

- Reconnect at the limit is a replacement, not 4405. Key moves free the old slot. Open relay ignores malformed member.
- Saving a key after the connector exited on 4402 starts a new one at once.
- A pasted phone pairing URI or host id in the key field is refused with a clear message (format test and UI).

## Docs and checks

`docs/guide.md` (key, two errors, new place of Remote and Usage), `CHANGELOG.md`, `docs/architecture.md`, `docs/agent-reference.md`. Checks: `cd relay && go vet ./... && go test -race ./...`, `npx vitest run server/src/remote scripts/protocol shared web`, `npx tsc -b`, `npm test`, `npm run build -w web`, `npm run e2e`. Smoke with a temp home: relay on 4791 with alice invited (limit 1), window on 4790: no key shows the 4402 text; alice's code goes online; a second host with the same key shows 4405; `nb-relay revoke alice` drops the first to 4402 within about 2 s. Stop only own processes.
