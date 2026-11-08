# Host connector and pairing (`nota-bene remote`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long-running `nota-bene remote` process on the host that keeps one outgoing connection to the relay, pairs phones by a QR code, runs an end-to-end Noise channel with each paired phone, and proxies the windows' `/ws` and HTTP routes through multiplexed streams inside that channel.

**Architecture:** Code in `server/src/remote/`. The connector reads the window registries of all three providers, proves each window with that provider's token (`/hello`, then the helper bearer) and proxies streams to it on 127.0.0.1. Phone ↔ host traffic is Noise_IK_25519_ChaChaPoly_SHA256 (phone = initiator, host's static key pinned from the QR), implemented here per the Noise spec on Node's built-in `crypto` and checked against the official test vectors. Inside the channel a small mux with HTTP/2-style per-stream and per-connection credit carries the streams. `pair`, `devices` and `revoke` talk to the running connector over a Unix socket.

**Tech Stack:** Node ≥22 (`node:crypto` X25519, ChaCha20-Poly1305, HMAC-SHA256; `node:net` Unix socket), `ws` 8.22.0 (already a server dependency), `uqr` 0.1.3 (terminal QR, MIT, no dependencies), Vitest, the Go relay from `relay/` for integration tests.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md`; relay contract `relay/PROTOCOL.md`.

## Global Constraints

- Published package supports Node ≥22; checkout needs Node ≥23.6. Only built-in `crypto` primitives; no native modules.
- New runtime dependency goes into `server/package.json` at an exact version (`"uqr": "0.1.3"`); it stays external in `scripts/build-package.mjs` like the others.
- Servers keep listening on 127.0.0.1 only; the connector opens no TCP listener. Its only listener is the Unix socket `<stateBase>/remote/control.sock` in a 700 folder, socket mode 600.
- Window credentials never leave the host: the phone never receives a token, bearer, cookie or key.
- Secret files (`host.key`, `devices.json`): mode 600, written via tmp file + rename, read with the same checks as `readSecret` in `server/src/auth.ts` (no symlink, regular file, own uid, no group/other bits).
- The relay sees only ciphertext, routing ids, the device hashes and the ticket; never the pairing secret.
- Tests: temp `NOTA_BENE_HOME`; window servers in-process with `port: 0`; nothing on 4777–4789; manual smoke only on 4790.
- Public repo: neutral fixtures (`relay.example.com`), no personal hosts, domains or keys.
- CLI output is English, like the launcher's; no web UI strings change in this issue (so no i18n work).
- Branch `gh-87-connector` → PR into `remote`. Every commit and the PR title match `^gh-87: .`.

## Review Focus

1. **A window restarts while a phone has streams open** (new launch nonce, old bearer invalid): an HTTP request is re-proved and retried once and succeeds; a WS stream closes with 4904 so the app reopens it. Test in Task 6.
2. **A phone stops reading mid-download** (app backgrounded): the host stops reading from the window once the phone's credit is used up, never has more than the connection window in flight to that phone, and other phones keep streaming. Tests in Tasks 3 and 6.
3. **The relay drops or the laptop sleeps:** the connector reconnects with backoff and re-sends its device list; a second connector with the same key (4409) or a refused host (4402) stops with a clear message instead of a reconnect loop. Tests in Task 4.
4. **`pair` run twice, or Ctrl-C during pairing:** the first code is cancelled and the relay's ticket cleared; a stale QR fails. Test in Task 7.
5. **Revoking a phone with a transfer in flight:** its channel is torn down by the connector at once, not when the relay's close arrives up to 10 s later. Test in Task 7.

---

### Task 1: Noise IK on node:crypto

**Files:**
- Create: `server/src/remote/noise.ts`
- Create: `server/src/remote/noise-vectors.json` (the `Noise_IK_25519_ChaChaPoly_SHA256` entries only, copied unchanged from the cacophony vectors, `vectors/cacophony.txt` in github.com/haskell-cryptography/cacophony; put the source URL, commit and licence in a `"source"` field at the top; if the licence does not allow copying, use the same suite's entries from the snow project's vector file and record that instead)
- Create: `server/src/remote/CHANNEL.md` (section "Handshake")
- Test: `server/src/remote/noise.test.ts`

**Interfaces:**
- Produces:
  - `type KeyPair = { pub: Buffer; priv: Buffer }` (raw 32-byte X25519).
  - `generateKeyPair(): KeyPair`, `publicOf(priv: Buffer): Buffer`, `dh(priv: Buffer, pub: Buffer): Buffer` (throws on an all-zero result).
  - `const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256'`.
  - `class Handshake` with `static initiator(o: { s: KeyPair; rs: Buffer; prologue: Buffer; e?: KeyPair })`, `static responder(o: { s: KeyPair; prologue: Buffer; e?: KeyPair })`, `writeMessage(payload: Buffer): Buffer`, `readMessage(msg: Buffer): Buffer` (returns the payload; throws `NoiseError` on a bad tag), `get remoteStatic(): Buffer | undefined`, `get handshakeHash(): Buffer`, `split(): { send: CipherState; recv: CipherState }` (only after both messages).
  - `class CipherState` with `encrypt(plain: Buffer, ad?: Buffer): Buffer`, `decrypt(cipher: Buffer, ad?: Buffer): Buffer` (throws `NoiseError`; a failed decrypt leaves the state unusable), nonce counter internal.
  - `const MAX_MESSAGE = 65535`, `const MAX_PLAINTEXT = 65535 - 16`.
  - `class NoiseError extends Error`.
  - `const PROLOGUE = Buffer.from('nb-e2e-v1')`.

- [ ] **Step 1: Write the failing tests** in `noise.test.ts`:
  - `vectors: every IK_25519_ChaChaPoly_SHA256 entry` — for each entry build initiator and responder with the vector's `init_static`, `init_ephemeral`, `init_remote_static`, `resp_static`, `resp_ephemeral`, `init_prologue`; run every message in `messages` alternately (handshake two messages, then transport via `split()`, initiator sends on even indexes); assert each produced ciphertext equals the vector's hex `ciphertext`, each read payload equals `payload`, and `handshakeHash` equals `handshake_hash` when present. Assert the file holds at least one entry (a test that iterates over nothing fails).
  - `round trip with fresh keys`: random keys, 2 handshake messages with payloads, then 3 transport messages each way; payloads come back; `responder.remoteStatic` equals the initiator's `s.pub`.
  - `a flipped bit fails`: flip one byte of message 1 → `readMessage` throws `NoiseError`; flip one byte of a transport message → `decrypt` throws and a following valid message also throws (state is dead).
  - `wrong pinned key fails`: initiator with `rs` = another key → responder's `readMessage` throws.
  - `low-order public key is refused`: `dh(priv, Buffer.alloc(32))` throws.
  - `oversized`: `encrypt` of `MAX_PLAINTEXT + 1` bytes throws.

- [ ] **Step 2: Run** `npx vitest run server/src/remote/noise.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `noise.ts`** per the Noise spec revision 34 (§5 processing rules, §7.5 IK pattern `<- s ... -> e, es, s, ss` / `<- e, ee, se`). Pinned details:
  - The protocol name is exactly 32 bytes, so `h` starts as the name itself; `ck = h`; then `MixHash(prologue)`, then the pre-message `MixHash(rs)` (responder's static, both sides).
  - HKDF per §4.3 with HMAC-SHA256 (chaining key as HMAC key), 2 outputs for MixKey/Split.
  - ChaCha20-Poly1305 via `createCipheriv('chacha20-poly1305', k, nonce, { authTagLength: 16 })`; nonce = 4 zero bytes ‖ 64-bit little-endian counter; associated data = `h` during the handshake. Before the first MixKey, `EncryptAndHash` is plain (no key).
  - Raw keys to `KeyObject`: private = DER `302e020100300506032b656e04220420` ‖ 32 bytes (`pkcs8`), public = `302a300506032b656e032100` ‖ 32 bytes (`spki`); `crypto.diffieHellman({ privateKey, publicKey })`.

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Write `CHANNEL.md` "Handshake"**: phone = initiator with the host key from the QR, host = responder, `PROLOGUE`, the suite name, one WebSocket binary message per Noise message, payload formats (filled in Task 6; leave a line pointing there), and that the Dart side must pass the same vector file in its CI (#88).

- [ ] **Step 6: Commit** — `gh-87: Noise IK handshake and transport on node:crypto, checked against the official vectors`.

### Task 2: Host key, device list, config and pairing derivations

**Files:**
- Modify: `server/src/auth.ts:40-66` — generalise `readSecret(file)` into `readPrivateFile(file: string, valid: RegExp, what: string): string | null` (same checks and messages, with `what` naming the content); `readSecret` becomes a thin wrapper, behaviour unchanged; export `readPrivateFile` and `writePrivateFile(file: string, content: string): void` (tmp in the same folder, mode 600, rename).
- Create: `server/src/remote/store.ts`
- Test: `server/src/remote/store.test.ts`

**Interfaces:**
- Consumes: `generateKeyPair`, `publicOf` (Task 1); `stateBaseDir()` (`server/src/state.ts`).
- Produces:
  - `remoteDir(): string` = `<stateBaseDir()>/remote`, created mode 700 (tightened like `stateDir`).
  - `hostKey(): KeyPair` — reads `remote/host.key` (base64url of the private key, 43 chars), creating it once.
  - `b64u(b: Buffer): string`, `fromB64u(s: string, len: number): Buffer` (throws on wrong length or alphabet).
  - `hostId(pub: Buffer): string` = `b64u(pub)`; `deviceHash(pub: Buffer): string` = `b64u(sha256(pub))`.
  - `fingerprint(pub: Buffer): string` — first 10 bytes of SHA-256(pub) in lowercase base32 (RFC 4648 alphabet), groups of 4 joined by `-` (16 chars, e.g. `abcd-efgh-ijkl-mnop`).
  - `type Device = { id: string; pub: string; name?: string; addedAt: number }` where `id` = first 4 characters of the fingerprint group string, lengthened to 8 or 16 characters on collision.
  - `readDevices(): Device[]`, `addDevice(pub: Buffer, name?: string): Device` (idempotent for the same key), `removeDevice(idOrPrefix: string): Device | null` (refuses an ambiguous prefix with an error naming the matches). File `remote/devices.json` = `{ "v": 1, "devices": Device[] }`.
  - `readConfig(): { relay?: string }`, `writeConfig(c: { relay?: string }): void`; file `remote/config.json` (mode 600). `relay` must be a `wss://` URL, or `ws://127.0.0.1:<port>` / `ws://localhost:<port>` for local runs; anything else throws.
  - `pairTicket(secret: Buffer): Buffer` = HMAC-SHA256(key = secret, `"nb-relay-ticket-v1"`); `pairProof(secret: Buffer, phonePub: Buffer): Buffer` = HMAC-SHA256(key = secret, `"nb-pair-v1"` ‖ phonePub).
  - `pairUri(o: { relay: string; hostPub: Buffer; secret: Buffer }): string` = `nbremote://pair?v=1&r=<encodeURIComponent(relay)>&h=<hostId>&s=<b64u(secret)>`, and `parsePairUri(s: string)` (the inverse; used by the test phone).

- [ ] **Step 1: Write the failing tests**: host key created once with mode 600 and stable across calls; a group-readable `host.key` throws naming `chmod 600`; `deviceHash` of the device public key in `relay/PROTOCOL.md`'s worked example equals the table's `deviceHash` (`qqj_9wO1CyKX9PbhNQj3JCDZb9Aeu4TLB0RJyq72QEE`); `addDevice` twice → one entry; `removeDevice` by full id and by unique prefix, ambiguous prefix throws, unknown → null; `writeConfig({ relay: 'http://x' })` throws; `pairUri`/`parsePairUri` round trip; `pairTicket` and `pairProof` match the worked example in `CHANNEL.md` (see Step 3; the test parses the table like `TestProtocolExample` does); `auth.test.ts` still passes unchanged.

- [ ] **Step 2: Run** `npx vitest run server/src/remote/store.test.ts server/src/auth.test.ts` — Expected: store FAIL, auth PASS.

- [ ] **Step 3: Implement**, then add to `CHANNEL.md` a "Pairing" section: QR URI format, ticket and proof derivations, and a worked-example table with pairing secret = bytes 0x41..0x60 and the device key of `relay/PROTOCOL.md`'s example (secret, ticket, proof, fingerprint of that device key), computed by the code.

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Commit** — `gh-87: host key, device list and pairing derivations under the state folder`.

### Task 3: Stream mux with credit

**Files:**
- Create: `server/src/remote/mux.ts`
- Test: `server/src/remote/mux.test.ts`
- Modify: `server/src/remote/CHANNEL.md` (section "Streams")

**Interfaces:**
- Consumes: nothing (pure; the transport is injected).
- Produces:
  - Frame layout (plaintext of one Noise transport message): `type u8 | stream u32 BE | flags u8 | body`. Types: `OPEN=1` (body JSON), `HEAD=2` (body JSON), `DATA=3` (flags bit0 `FIN` = end of one message, bit1 `BIN` = a binary WebSocket message), `END=4` (half-close: no more DATA from this side), `CLOSE=5` (body JSON `{code:number, reason?:string}`, ends the stream both ways), `CREDIT=6` (body u32 BE bytes granted; stream 0 = connection-level).
  - `encodeFrame(f: Frame): Buffer`, `decodeFrame(b: Buffer): Frame` (throws `MuxError` on an unknown type, short buffer or bad JSON).
  - `const STREAM_WINDOW = 256 * 1024`, `const CONN_WINDOW = 512 * 1024`, `const MAX_CHUNK = 65535 - 16 - 6`, `const MAX_STREAMS = 64`.
  - `class Mux` (one per device channel): `constructor(o: { send: (plain: Buffer) => void; onOpen: (s: Stream, open: unknown) => void })`, `receive(plain: Buffer): void`, `open(open: unknown): Stream` (used by the test phone; ids the opener picks: phone uses odd ids, host never opens), `close(): void` (closes every stream).
  - `class Stream extends EventEmitter` — events `head(json)`, `message(data: Buffer, binary: boolean)` (reassembled from DATA chunks until `FIN`), `end`, `close({code, reason})`; methods `head(json)`, `write(data: Buffer, binary = false): boolean` (chunks to `MAX_CHUNK`, queues beyond credit, returns false when the queue is non-empty), `end()`, `close(code, reason?)`, event `drain` when the queue empties; `consumed(n)` is called automatically when a `message` handler returns, granting `CREDIT` back once half a window is consumed. Received DATA beyond granted credit is a protocol error → `CLOSE {code: 4900}` on the connection (all streams) via `close()`.
  - Close codes: `4900` bad frame / credit violation, `4904` window unknown or gone, `4929` too many streams, `4902` window unreachable; WebSocket streams pass the window's own close code through.

- [ ] **Step 1: Write the failing tests** (two `Mux` instances wired back to back with an in-memory `send`):
  - `codec round trip` for each type; `decodeFrame` of 5 bytes throws.
  - `message larger than a chunk` (300 KiB) arrives as one `message`, equal bytes.
  - `sender stops at credit`: receiver's handler never returns (holds a promise) → sender has sent ≤ `STREAM_WINDOW` bytes of DATA bodies, `write` returned false; release → rest arrives, `drain` fires.
  - `connection window bounds the total`: 4 streams each writing 1 MiB to a receiver that never consumes → total DATA bytes sent ≤ `CONN_WINDOW`.
  - `credit violation closes everything`: craft a DATA frame beyond the window → both streams get `close` with 4900.
  - `65th open` → `CLOSE 4929` for that stream, others unaffected.
  - `END then CLOSE` order: `end` event before `close`.

- [ ] **Step 2: Run** `npx vitest run server/src/remote/mux.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `mux.ts`**, and write `CHANNEL.md` "Streams" with the layout, the windows, the codes and one hex example of a `DATA` frame.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `gh-87: stream mux with per-stream and per-connection credit`.

### Task 4: Relay client

**Files:**
- Create: `server/src/remote/relayClient.ts`
- Create: `server/src/remote/testRelay.ts` (test helper: `go build -o <tmp>/nb-relay ./cmd/nb-relay` with `cwd: relay/`, then spawn `nb-relay -listen 127.0.0.1:<free port>`, wait for `GET /healthz` = `ok`; returns `{ url: 'ws://127.0.0.1:<port>', stop(): Promise<void> }`)
- Modify: `.github/workflows/ci.yml` — in job `test`, add `actions/setup-go@v5` with `go-version-file: relay/go.mod` and `cache-dependency-path: relay/go.sum` before `npm test`.
- Test: `server/src/remote/relayClient.test.ts`

**Interfaces:**
- Consumes: `hostKey`, `deviceHash`, `b64u`, `fromB64u` (Task 2); `dh`, `generateKeyPair` (Task 1); `ws`.
- Produces:
  - `relayProof(role: 'host' | 'device', priv: Buffer, eph: Buffer, nonce: Buffer): Buffer` = HMAC-SHA256(key = `dh(priv, eph)`, `"nb-relay-v1 <role>"` ‖ nonce). Also used by the test phone.
  - `class RelayClient extends EventEmitter`: `constructor(o: { url: string; key: KeyPair; devices: () => string[]; ticket: () => Buffer | null; backoff?: { minMs: number; maxMs: number } })`, `start()`, `stop(): Promise<void>`, `setDevices(hashes: string[])`, `setTicket(t: Buffer | null)`, `closeConn(conn: number)`, `send(conn: number, payload: Buffer)`; events `online`, `offline(code: number)`, `open(conn: number, device: string)`, `gone(conn: number)`, `frame(conn: number, payload: Buffer)`, `fatal(code: number, message: string)`.
  - Reconnect: exponential backoff from `minMs` (default 1000) to `maxMs` (default 30000) with ±20 % jitter, reset after 60 s online. Codes 4401, 4402, 4413 → `fatal` with a message naming the cause, no retry; 4409 → `fatal('another nota-bene remote with this host key is connected')`, no retry; everything else (including 1001, 1006, 4408, 4429) → retry. On every (re)connect the hello carries the current `devices()` and `ticket()`. After `offline`, every conn is reported `gone`.

- [ ] **Step 1: Write the failing tests** against a real relay from `testRelay.ts`:
  - `relayProof` reproduces the host and device proofs of `relay/PROTOCOL.md`'s worked example.
  - `admits and routes`: host client online; a raw `ws` device (helper in the test using `relayProof`, listed by hash) connects → host gets `open(conn, hash)`; device sends bytes → host `frame(conn, bytes)`; `send(conn, …)` reaches the device.
  - `ticket admits an unlisted device`; after `setTicket(null)` and `setDevices([])` the device is closed with 4403.
  - `closeConn` → device closed 4403, host gets `gone`.
  - `reconnects`: stop the relay, start a new one on the same port → `offline`, then `online` within `maxMs` (use `{ minMs: 50, maxMs: 200 }`), and the device list was re-sent (the listed device is admitted again).
  - `second host with same key` → the first client emits `fatal` with the 4409 message and does not reconnect (wait 3× `maxMs`, no new `online`).

- [ ] **Step 2: Run** `npx vitest run server/src/remote/relayClient.test.ts` — Expected: FAIL (needs `go` on PATH; a missing `go` is a failure, not a skip).

- [ ] **Step 3: Implement** `relayClient.ts` and `testRelay.ts`; the CI change.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `gh-87: relay client with admission, reconnect and close-code policy`.

### Task 5: Window discovery across providers

**Files:**
- Modify: `server/src/windows.ts:26-52` — `readWindows(stateDirOverride?: string)` reads `<stateDirOverride ?? stateDir()>/windows`; behaviour without the argument unchanged.
- Modify: `server/src/auth.ts:126-146` — `proveListener` and `verifiedBearer` take an optional `token` (default `accessToken()`); behaviour without it unchanged.
- Create: `server/src/remote/discover.ts`
- Test: `server/src/remote/discover.test.ts`

**Interfaces:**
- Consumes: `providerStateDir`, `AgentProvider` (`server/src/agent/provider.ts`), `stateBaseDir`, `readPrivateFile` (Task 2), `pidAlive`, `readWindows`, `proveListener`, `helperCredential`.
- Produces:
  - `type HostWindow = { port: number; provider: AgentProvider; root: string; bearer: string; nonce: string }`.
  - `class Windows extends EventEmitter`: `constructor(o?: { pollMs?: number /* 3000 */; fetchFn?: typeof fetch })`, `start()`, `stop()`, `list(): HostWindow[]`, `get(port: number): HostWindow | undefined`, `reprove(port: number): Promise<HostWindow | undefined>` (fresh `/hello`; drops the window if it fails); event `change(list)` when the set or any nonce changes.
  - A provider whose `token` file is missing is skipped (the connector never creates tokens); a token file with bad permissions is reported once per poll as an `error` event and skipped. Entries are only hints: listed only after a proof with that provider's token; the connector never unregisters entries (that stays with the launcher and `liveWindows`).
  - `windowInfo(w: HostWindow, fetchFn?): Promise<Record<string, unknown> | null>` — `GET /info` with the bearer and `Host: 127.0.0.1:<port>`.

- [ ] **Step 1: Write the failing tests** with a temp `NOTA_BENE_HOME`: start two in-process window servers (`startServer({ cwd, port: 0, backend: fakeBackend(...), exit: () => {} })`), one with `NOTA_BENE_AGENT` unset (claude dir), one registered under `providers/codex` (create its token with `writePrivateFile` and register via `registerWindow` with the codex dir as state; follow the provider setup used in existing codex tests) → `list()` holds both with the right `provider`; `windowInfo` answers with the server's `root`; a registry entry whose port answers another token's proof is not listed; stopping a server → `change` without it on the next poll; no `token` for omp → no error; `readWindows()` and `verifiedBearer()` callers' existing tests still pass.

- [ ] **Step 2: Run** `npx vitest run server/src/remote/discover.test.ts server/src/windows.test.ts server/src/auth.test.ts` — Expected: discover FAIL, others PASS.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `gh-87: discover windows of every provider and prove each with its own token`.

### Task 6: Device channel and stream handlers

**Files:**
- Create: `server/src/remote/device.ts`
- Create: `server/src/remote/testPhone.ts` (the scripted phone: relay admission as a device, Noise initiator, `Mux` client; the reference behaviour for the Dart app)
- Modify: `server/src/remote/CHANNEL.md` (sections "Payloads", "Stream kinds")
- Test: `server/src/remote/device.test.ts`

**Interfaces:**
- Consumes: `Handshake`, `PROLOGUE`, `NoiseError` (Task 1); `pairProof`, `deviceHash`, `readDevices` (Task 2); `Mux`, `Stream`, close codes (Task 3); `Windows`, `windowInfo` (Task 5).
- Produces:
  - Handshake payloads (JSON, UTF-8): message 1 (phone → host) `{ "v": 1, "name"?: string, "pair"?: <b64u proof> }`; message 2 (host → phone) `{ "v": 1, "ok": true }`. A phone whose key is not in `devices.json` and whose `pair` proof does not match the in-flight pairing gets no message 2: the connector closes the conn.
  - `class DeviceChannel`: `constructor(o: { hostKey: KeyPair; send: (b: Buffer) => void; drop: () => void; windows: Windows; pairing: () => { secret: Buffer } | null; onPaired: (pub: Buffer, name?: string) => boolean /* false = refused (already consumed) */; isListed: (pub: Buffer) => boolean })`, `receive(b: Buffer)`, `close()`, `get devicePub(): Buffer | undefined`.
  - OPEN bodies the host accepts:
    - `{ "kind": "host" }` — host stream: the host sends `{ "t": "windows", "windows": [{ port, provider, root, title?, session?, model?, busy?, supervised? }] }` on open and on every change (window set from `Windows`, fields from `/info`, polled every 5 s only while a host stream is open), each as one `FIN` message.
    - `{ "kind": "ws", "port": n, "path": "/ws?..." }` — `path` must start with `/ws` (`/ws` or `/ws?`); proxied to `ws://127.0.0.1:<port><path>` with `Authorization` = bearer, `Host: 127.0.0.1:<port>`, no `Origin`. Messages both ways keep their text/binary kind; the window's close code is passed through in `CLOSE`.
    - `{ "kind": "http", "port": n, "method": "GET"|"HEAD"|"POST"|"PUT"|"PATCH"|"DELETE", "path": "/…", "headers"?: Record<string,string> }` — request body = DATA until `END`; response = `HEAD {status, headers}` then DATA then `END`. Forwarded request headers: only `accept`, `content-type`, `range`, `if-none-match`, `if-range`, `if-modified-since`. Added: `Authorization`, `Host: 127.0.0.1:<port>`, and `Origin: http://127.0.0.1:<port>` for non-GET/HEAD. Refused with `CLOSE 4900`: a path not starting with `/`, starting with `//`, or under `/control/`. Response headers dropped: `set-cookie`. A 401 answer → `reprove(port)` once and repeat the request (only when the request had no body or the body was fully buffered, ≤ 1 MiB).
    - Unknown `port` → `CLOSE 4904`. Responses are read from the window only as fast as the stream's credit allows (pause/resume the upstream).

- [ ] **Step 1: Write the failing tests** (in-process window servers as in Task 5; `DeviceChannel` and `testPhone` wired back to back in memory, no relay):
  - `listed phone completes the handshake`; `unlisted phone without proof` → `drop` called, no message 2.
  - `pairing proof adds the phone`: `pairing()` returns a secret, phone sends `pair` → `onPaired(pub, name)` called; a second phone with a proof after `onPaired` returned false → dropped.
  - `host stream lists windows` with `root` and `provider`.
  - `ws stream`: a WS to the window's `/ws?tab=t1` receives the window's first server event (same as a browser tab would); a client message sent through reaches the server (assert via an observable effect used in `onetab.test.ts`, e.g. a second tab gets `occupied` and `{"type":"takeover"}` makes the first stream `CLOSE` with code 4001).
  - `http GET /info` → 200 and JSON `root`; `GET /file?path=<fixture>` with `range: bytes=0-9` → 206 and 10 bytes; `POST` to a write route works (the Origin rule); `GET /control/anything` → `CLOSE 4900`; `GET //evil` → `CLOSE 4900`.
  - Review Focus 1: restart the window on the same port with a new nonce → the next HTTP request still answers 200 (reprove + retry), the open WS stream got `CLOSE 4904` or the window's own close code.
  - Review Focus 2: phone grants no credit on a 2 MiB file download → host has sent ≤ `CONN_WINDOW` bytes; a second phone channel to the same window downloads the same file meanwhile.

- [ ] **Step 2: Run** `npx vitest run server/src/remote/device.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `device.ts` and `testPhone.ts`; write the `CHANNEL.md` sections.**

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** — `gh-87: device channel proxies the windows' ws and http routes through the mux`.

### Task 7: Connector, control socket, pairing and CLI

**Files:**
- Create: `server/src/remote/connector.ts`, `server/src/remote/control.ts`, `server/src/remote/cli.ts`
- Modify: `bin/nota-bene.mjs` — before `parseArgs` in `main`, `if (argv[0] === 'remote') return (await import('../server/src/remote/cli.ts')).remoteMain(argv.slice(1))`; add the `remote` line to `USAGE`.
- Modify: `server/package.json` — `"uqr": "0.1.3"`; `package-lock.json` via `npm install`.
- Test: `server/src/remote/connector.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `class Connector`: `constructor(o: { relay: string; windows?: Windows; pairTtlMs?: number /* 300000 */ })`, `start(): Promise<void>` (throws `'nota-bene remote is already running'` when `control.sock` answers), `stop()`; it owns the `RelayClient`, one `DeviceChannel` per relay `conn`, the in-flight pairing.
  - Pairing state machine: `startPairing(): { uri: string; hostFingerprint: string }` cancels a previous one; the secret lives in memory only; relay ticket = `pairTicket(secret)` while in flight; consumed by the first valid proof (device added, relay `devices` updated, ticket cleared); any later proof with that secret is refused and emitted as `pair-refused(fingerprint)`; expiry after `pairTtlMs` or cancel → ticket cleared.
  - `revoke(id)`: removes from `devices.json`, sends the new list to the relay, sends `close{conn}` for every live conn of that key, and tears down those channels immediately (their frames are ignored from then on).
  - Control socket `remote/control.sock` (mode 600), newline-delimited JSON. Requests: `{"op":"status"}` → `{ online, relay, hostFingerprint, windows: n, devices: [{ id, name?, fingerprint, online }] }`; `{"op":"devices"}` → `{ devices: [...] }`; `{"op":"revoke","id":s}` → `{ ok, device? , error? }`; `{"op":"pair"}` → a stream of `{ "t":"code", uri, hostFingerprint, expiresAt }`, then one of `{ "t":"paired", device }`, `{ "t":"expired" }`, `{ "t":"cancelled" }` (another `pair` started); `pair-refused` events go to every attached `pair` client as `{ "t":"refused", fingerprint }` and to the connector's stderr. Closing the `pair` client's socket cancels its pairing.
  - CLI `remoteMain(argv)`: `nota-bene remote [--relay URL]` runs the connector in the foreground (saves `--relay` to config; without a saved or given relay prints how to set one and exits 2; prints host fingerprint and `online`/`offline` transitions, never content); `nota-bene remote pair` prints the QR (`uqr` `renderUnicodeCompact`), the URI below it, the host fingerprint, and waits; on `paired` prints the device fingerprint and name, exits 0; `expired` exits 1; Ctrl-C cancels. `nota-bene remote devices` prints `id  name  fingerprint  online`. `nota-bene remote revoke <id>` prints the removed device or the error, exit 1 on error. Commands other than the foreground run exit 1 with "nota-bene remote is not running" when the socket does not answer.

- [ ] **Step 1: Write the failing tests** (real relay from `testRelay.ts`, temp `NOTA_BENE_HOME`, `pairTtlMs: 500` where expiry is tested, phone = `testPhone.ts`):
  - `pairs through the relay`: control `pair` → code; phone parses the URI, connects with the ticket and the proof → control client gets `paired`; `devices` lists it with `online: true`; a later phone using the same URI is refused (control gets `refused`).
  - Review Focus 4: `pair` twice → the first control client gets `cancelled`, and a phone using the first URI is refused by the relay (4403); closing a `pair` client → the ticket is cleared (a phone using that URI gets 4403).
  - `expired` after 500 ms.
  - Review Focus 5: a paired phone downloading a large file; `revoke` its id → the phone's stream stops within 500 ms (well under the relay's 10 s), `devices` no longer lists it, and its next connection is refused 4403.
  - `second start` throws `already running`.
  - `cli`: `remoteMain(['devices'])` with no connector → exit 1 and the not-running message; with one → the table.
  - `bin` dispatch: `parseArgs` is not reached for `remote` (a test in `bin/` calling `main(['remote','devices'])` with no connector → exit 1 and the not-running message, not a USAGE error).

- [ ] **Step 2: Run** `npx vitest run server/src/remote/connector.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**; `npm install uqr@0.1.3 -w server --save-exact`.

- [ ] **Step 4: Run** `npx vitest run server/src/remote/` and the touched `bin/` test — Expected: PASS.

- [ ] **Step 5: Commit** — `gh-87: nota-bene remote connector, control socket, pairing and revoke`.

### Task 8: End to end through the relay, packaging and docs

**Files:**
- Test: `server/src/remote/e2e.test.ts`
- Modify: `docs/guide.md` (a "Remote access (prototype)" section: start the connector, pair, list, revoke, what the relay sees), `docs/architecture.md` §2.3 (the connector, the channel, link to `server/src/remote/CHANNEL.md`), `docs/agent-reference.md` (the state files under `remote/` and the control socket in the state/security notes).
- Check: `scripts/build-package.mjs` output runs `nota-bene remote --help`.

- [ ] **Step 1: Write `e2e.test.ts`**: real relay, one in-process window, connector, pairing through the control socket, then as the phone: host stream lists the window; `ws` stream to `/ws?tab=p1` gets the first server event; `http GET /info` → 200; `GET /file` with Range → 206 and exact bytes; stop the relay and start it again on the same port → the phone reconnects (as the app will) and the host stream lists the window again; finally the connector's stderr and the relay's output contain neither the file's bytes nor the pairing secret (assert by searching for both).
- [ ] **Step 2: Run** `npx vitest run server/src/remote/e2e.test.ts` — Expected: PASS (all pieces exist; fix what it finds).
- [ ] **Step 3: Docs** as listed; parse-check any Mermaid.
- [ ] **Step 4: Package check**: `node scripts/build-package.mjs` (as the release section of `docs/agent-reference.md` describes), install the tarball into a temp prefix, run `<prefix>/bin/nota-bene remote --help` → exit 0 and the usage text; `uqr` resolves.
- [ ] **Step 5: Full checks, one at a time:** `npx tsc -b`, `npm test`, `cd relay && go test -race ./...`. Expected: all exit 0.
- [ ] **Step 6: Commit** — `gh-87: end-to-end test through the relay and docs for nota-bene remote`.

## Left for #88 (the Dart side)

The Dart implementation of `noise.ts`, the mux and the pairing URI, run in CI against the same `noise-vectors.json` and the `CHANNEL.md` worked examples, plus one cross-language test: the Dart client handshakes and opens a host stream against a Node connector through a local relay.
