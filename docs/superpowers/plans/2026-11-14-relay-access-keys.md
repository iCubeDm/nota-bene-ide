# Relay access keys: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A relay started with `-members` admits only hosts whose hello is signed by a member's Ed25519 key, at most N hosts per key, with live revocation; the host and the window carry the key; Remote and Usage move into the settings menu.

**Architecture:** The hub verifies an optional `member`/`sig` pair in the host hello and asks the `Admit` hook for that key's host limit; it counts hosts per member and exposes `Revoke`/`Limit`. `nb-relay` implements the hook from a JSON members file it re-reads every 2 s, and gains `invite`/`revoke`/`members`/`limit` subcommands. The connector reads `remote/access-key` on every connection; the window saves it through `POST /remote/config` and shows `accessKey: boolean` (protocol 21).

**Tech Stack:** Go (`crypto/ed25519`, `github.com/coder/websocket`), Node TypeScript (`node:crypto` Ed25519, Vitest), React + Redux (Vitest + Testing Library), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-14-relay-access-keys-design.md`

## Global Constraints

- Tests and smoke use only ports 4790–4795 and a temporary `NOTA_BENE_HOME`; never probe a live window or the user's `~/.nota-bene`.
- No code, seed or member key in logs, error messages, URLs or page state. Relay logs stay counts and close codes.
- Code format `nbk1_` + base64url(32-byte seed), 48 characters; member id = base64url(public key), 43 characters.
- Signed message: ASCII `nb-relay-v1 member` ‖ nonce(32) ‖ eph(32) ‖ host key(32).
- New close code 4405: the key's host limit is reached (at hello, or after `ok` when a limit is lowered); retry with backoff.
- Default limit 3 hosts per key. Members file JSON, mode 0600, atomic writes, re-read every 2 s; a bad re-read keeps the old list.
- Protocol 20 → 21. All new UI text in all six `LANGS`, real translations. Public repo: neutral fixtures (`alice`, `relay.example.com`).

## Review Focus

- A host reconnecting (same host id, same key) while at the limit must be admitted (replacement), not refused with 4405 — test in Task 1.
- A host id moving to another key frees its slot under the old key — test in Task 1.
- An open relay (no hook) with a malformed `member` still admits — test in Task 1.
- Saving a key while the connector already exited on 4402 must start a new one at once, not after back-off — test in Task 4.
- A pasted phone pairing URI or host id in the key field is refused with a clear message — test in Task 3 (format) and Task 5 (UI).

---

### Task 1: Hub verifies member signatures and enforces per-key limits

**Files:**
- Modify: `relay/hub/auth.go`, `relay/hub/hub.go`, `relay/hub/server.go`
- Test: `relay/hub/auth_test.go`, `relay/hub/hub_test.go`, `relay/hub/testclient_test.go`

**Interfaces:**
- Produces:
  - `func MemberSign(seed [32]byte, nonce, eph, hostKey [32]byte) []byte` and `func VerifyMember(pub [32]byte, nonce, eph, hostKey [32]byte, sig []byte) bool` (auth.go).
  - `Options.Admit func(ctx context.Context, hostID string, member *[32]byte) (hosts int, ok bool)`: `member` nil when the hello has none (or it failed verification on a hooked hub: then the hub refuses before asking). `hosts <= 0` = no per-key limit.
  - `func (s *Server) Revoke(member [32]byte)`: closes that member's hosts with 4402.
  - `func (s *Server) Limit(member [32]byte, hosts int)`: closes the most recently admitted hosts above `hosts` with 4405.
  - `codeKeyLimit = websocket.StatusCode(4405)`.

- [ ] **Step 1: Write failing tests** — `TestMemberSignVector` (fixed seed 0x41..0x60 with the protocol example's eph/nonce/host key; asserts `VerifyMember` true, and false when any of the three inputs or one sig byte changes); in hub_test: `TestMemberRequiredWithHook` (hook set: no member → 4402; bad sig → 4402; malformed member → 4402; valid → ok), `TestOpenRelayIgnoresMember` (no hook: malformed member/sig → ok), `TestMemberHostLimit` (limit 2: hosts A, B ok; C → 4405; A reconnects with same key → ok, old A gets 4409; B leaves; C → ok), `TestHostMovesKey` (host A under key1 reconnects under key2: key1's slot is freed), `TestRevokeAndLimit` (Revoke → both hosts 4402; Limit(1) with 2 hosts → the later one 4405). Extend the test client to send `member`/`sig`.
- [ ] **Step 2: Run** `cd relay && go test ./hub/` — FAIL (undefined MemberSign, Admit signature).
- [ ] **Step 3: Implement.** `hello` gains `Member`, `Sig` strings. In `runHost`: when `Admit` is nil, ignore them. Otherwise parse (`decodeKey` for member, 86-char base64url for sig), verify, call the hook with the key; refusal → 4402. `host` gains `member *[32]byte` and `admitted time.Time`; `register` checks the count of other host ids with the same member under `s.mu` (the replaced host with the same id and member doesn't count) and returns a distinct result for 4405 vs 4429. `Revoke`/`Limit` take `s.mu`, pick hosts, then `closeWith` + `shutdown` outside the lock, like `register` does for the replaced host. Update the existing `TestAdmitHook` to the new signature.
- [ ] **Step 4: Run** `cd relay && go vet ./... && go test -race ./...` — PASS.
- [ ] **Step 5: Commit** `gh-371: relay hub: member keys and per-key host limits`.

### Task 2: `nb-relay` members file, watcher and subcommands

**Files:**
- Create: `relay/cmd/nb-relay/members.go`, `relay/cmd/nb-relay/members_test.go`
- Modify: `relay/cmd/nb-relay/main.go`, `relay/cmd/nb-relay/main_test.go`, `relay/README.md`, `relay/PROTOCOL.md`

**Interfaces:**
- Consumes: Task 1 `Options.Admit`, `Server.Revoke`, `Server.Limit`, `MemberSign`.
- Produces: file format `{"members":[{"name","key","hosts","added"}]}`; `nb-relay invite|revoke|members|limit -members FILE …`; server flag `-members FILE`.

- [ ] **Step 1: Write failing tests** — members_test: `TestInviteWritesPublicHalfOnly` (invite alice → stdout has one `nbk1_` code of 48 chars; file mode 0600; file holds alice's public key derived from the code's seed and `hosts:3`; the seed's base64 is not in the file); `TestInviteRefusesDuplicateAndBadName`; `TestRevokeAndLimitEditFile`; `TestMembersListsWithoutKeys`; `TestReloadAppliesChanges` (load, start watcher with a 50 ms tick, revoke alice in the file → the fake hub sees `Revoke(alice)`; lower limit → `Limit`; broken JSON → old list kept, an error logged); main_test: `TestMembersFlagAdmitsOnlyMembers` (run the server on `127.0.0.1:0` with a file holding one member: a host without key → 4402, with the invited key → ok); `TestProtocolExample` extended to the new table row.
- [ ] **Step 2: Run** `cd relay && go test ./cmd/...` — FAIL.
- [ ] **Step 3: Implement.** `run` dispatches on `args[0]` ∈ {invite, revoke, members, limit} before the server flag set. Names `^[A-Za-z0-9._-]{1,40}$`. Writes: temp file in the same dir, mode 0600, rename. The watcher stats the file every 2 s (tick injectable for tests), re-reads on mtime/size change, diffs old vs new: removed key → `Revoke`, lowered `hosts` → `Limit`. Admit answers from the current list under a mutex. At start a missing or bad file is an error (exit non-zero).
- [ ] **Step 4: Docs.** PROTOCOL.md: member fields, signed message, example row (member seed 0x41..0x60, its public key, the sig), 4405 in the code table and retry rules, 4402 wording ("no or unknown access key"). README: `-members`, subcommands, systemd and container usage (`--entrypoint /nb-relay`, file owned by uid 65532), the three-step switch-over from the spec.
- [ ] **Step 5: Run** `cd relay && go vet ./... && go test -race ./...` — PASS. **Commit** `gh-371: nb-relay: members file, invite and revoke`.

### Task 3: Host connector signs with the access key

**Files:**
- Modify: `server/src/remote/store.ts`, `server/src/remote/relayClient.ts`, `server/src/remote/connector.ts`, `server/src/remote/cli.ts`, `server/src/remote/testRelay.ts`
- Test: `server/src/remote/store.test.ts`, `server/src/remote/relayClient.test.ts`, `server/src/remote/connector.test.ts`, `server/src/remote/cli.test.ts` (if present; otherwise in connector.test.ts)

**Interfaces:**
- Produces:
  - store: `parseAccessKey(code: string): Buffer` (seed; throws `Error('an access key starts with nbk1_ and has 48 characters')`, with a distinct message when the input looks like `nbremote://`), `readAccessKey(): Buffer | null`, `writeAccessKey(code: string | null): void` (file `remote/access-key`, 0600, the code text), `memberSign(seed, nonce, eph, hostPub): Buffer`, `memberPub(seed): Buffer`.
  - RelayClient option `member: () => Buffer | null` (seed, read per connection). Close 4405 is not fatal; emits `limited` on it. FATAL[4402] = 'the relay does not admit this host: the access key is missing, unknown or revoked'.
  - Connector control op `reconnect`: drops the relay socket and reconnects now with backoff reset; answers `{t:'ok'}`. On `limited`: `writeLastError({code: 4405, message: 'this access key is already used on the most computers allowed', at})`; cleared on online as today.
  - CLI: `nota-bene remote key` (reads one line from stdin, no echo on a TTY; saves; prints "saved"), `nota-bene remote key --clear`. `REMOTE_USAGE` lists them.
- [ ] **Step 1: Write failing tests** — store: `parseAccessKey` accepts a valid code, refuses wrong prefix/length/a pairing URI (message mentions the phone code), `writeAccessKey` 0600 and null removes; `memberSign` equals the protocol example's sig (same vector as Task 1); relayClient: the hello carries `member` (base64url public key) and `sig` when `member()` returns a seed, none otherwise; a 4405 close reconnects and emits `limited`; 4402 is fatal with the new message; connector: `reconnect` op reconnects with the newly saved key (test relay records the member of each hello); a 4405 writes last-error, going online clears it. Make `testRelay.ts` record `member`/`sig` and optionally close with a given code.
- [ ] **Step 2: Run** `npx vitest run server/src/remote` — FAIL.
- [ ] **Step 3: Implement** with `node:crypto`: private key from seed via PKCS#8 DER prefix `302e020100300506032b657004220420`; `sign(null, msg, key)`; public key from `createPublicKey(...).export({ format: 'jwk' }).x`.
- [ ] **Step 4: Run** `npx vitest run server/src/remote && npx tsc -b` — PASS. **Commit** `gh-371: the connector signs its relay hello with the access key`.

### Task 4: Window: protocol 21, config route and keeper

**Files:**
- Modify: `shared/src/protocol.ts`, `shared/fixtures/protocol.json`, `scripts/protocol/dart.test.ts`, generated `mobile/protocol/lib/src/protocol.g.dart` and `shared/schema/protocol.schema.json` (`npm run gen:protocol`), `server/src/remote/keeper.ts`, `server/src/remote/routes.ts`
- Test: `server/src/remote/keeper.test.ts`, `server/src/remote/routes.test.ts`

**Interfaces:**
- Consumes: Task 3 store functions and the `reconnect` op.
- Produces: `RemoteState.accessKey: boolean`; `PROTOCOL = 21` with a history line; `keeper.setConfig(c: RemoteConfig & { accessKey?: string | null })`; route `POST /remote/config` accepts `accessKey: string | null` (400 on a bad format with the store's message; 409 `legacy` for a versionless connector).
- [ ] **Step 1: Write failing tests** — keeper: `accessKey` false then true after `setConfig({accessKey: code})`; the key file holds the code; a running connector gets `reconnect`; a connector that exited on 4402 (last-error 4402, back-off armed) is started again in the same call; `accessKey: null` removes the file; state never contains the code (`JSON.stringify(state)` doesn't include it). routes: accessKey passed trimmed, `5` → 400, bad format → 400 with message, null → passed.
- [ ] **Step 2: Run** `npx vitest run server/src/remote` — FAIL.
- [ ] **Step 3: Implement**; regenerate protocol; bump the dart test and fixtures (a `remote` fixture with `accessKey`).
- [ ] **Step 4: Run** `npx vitest run server/src/remote scripts/protocol shared && npx tsc -b` — PASS. **Commit** `gh-371: protocol 21: the window saves the access key`.

### Task 5: Web: access key row, errors, settings menu

**Files:**
- Modify: `web/src/remote/RemoteView.tsx`, `web/src/remote/RemoteButton.tsx` (becomes `RemoteMenuRow` + `RemoteDot`), `web/src/remote/api.ts`, `web/src/shell/Header.tsx`, `web/src/i18n/*` (all six languages), `e2e/usage.spec.ts`
- Test: `web/src/remote/RemoteView.test.tsx`

**Interfaces:**
- Consumes: `RemoteState.accessKey`, `lastError.code` 4402/4405.
- Produces: ids `remoteMenu`, `usageMenu`, `settingsDot` (data-state = indicator); `#remoteAccessKey` field.
- [ ] **Step 1: Write failing tests** — header: no `#remoteBtn`/`#usageBtn`; opening the settings menu shows `#remoteMenu` with the state text (online · 2) and `#usageMenu`; clicking each opens its tab; `#settingsDot` data-state online/connecting/trouble and absent when off or protocol 19. Tab: with `accessKey:false` a password field and Save posts `{accessKey}`; a 400 shows the reason; with `accessKey:true` shows "set" and Change/Remove (Remove posts `{accessKey:null}`); lastError 4402 shows the "enter the access key" text, 4405 the "most computers allowed" text, in the tab and the menu row's tooltip.
- [ ] **Step 2: Run** `npx vitest run web/src/remote` — FAIL.
- [ ] **Step 3: Implement**; header rows in the menu's `row` style above the separator before "All settings"; the dot positioned on the gear like the old indicator's. Translations for every new key in all `LANGS`.
- [ ] **Step 4: Run** `npx vitest run web && npm run build -w web` — PASS; update `e2e/usage.spec.ts` to open the settings menu then `#usageMenu`. **Commit** `gh-371: web: the access key in the Remote tab; Remote and Usage in the settings menu`.

### Task 6: Docs, full checks, smoke

**Files:**
- Modify: `docs/guide.md` (Remote access: the key, the two errors, where Remote and Usage are now), `CHANGELOG.md` (Unreleased), `docs/architecture.md`, `docs/agent-reference.md` (relay `-members`)

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** `npx tsc -b && npm test && npm run build -w web && (cd relay && go test -race ./...)` and `npm run e2e` — all exit 0.
- [ ] **Step 3: Smoke** with a temporary `NOTA_BENE_HOME`: `nb-relay -listen 127.0.0.1:4791 -members $TMP/members.json` with alice invited (limit 1); a window on 4790 with relay `ws://127.0.0.1:4791`: no key → tab shows the 4402 text; enter alice's code → online; a second host (another temp home) with the same key → 4405 text; `nb-relay revoke alice` → first host drops to 4402 within ~2 s. Stop only own processes; trash the temp dirs.
- [ ] **Step 4: Commit** `gh-371: docs: relay access keys`; push; open the PR.
