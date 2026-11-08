# Remote relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless Go relay in `relay/` that pairs one host connector with its devices by host id and forwards their encrypted bytes, plus a container image recipe for it (issue #86, part of #63).

**Architecture:** One static binary. Hosts and devices connect over WebSocket (TLS by autocert in production, plain on loopback in tests). Each side first proves possession of its X25519 key to the relay; the host also hands the relay the hashes of its paired device keys and, while pairing, one ticket id. After admission the relay forwards binary frames: a device's frames go to its host prefixed with a connection number, the host's frames go to the device the prefix names. Nothing is stored, queued past a small bound, or logged beyond counts.

**Tech Stack:** Go 1.27 (module `github.com/iCubeDm/nota-bene-ide/relay`), `github.com/coder/websocket`, `golang.org/x/crypto` (`curve25519`, `acme/autocert`), standard `testing` with `net/http/httptest`; a multi-stage `Dockerfile` (distroless static, non-root).

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` (sections Shape, Identity/pairing/channel, What goes through the channel, Deployment).


## Global Constraints

- The relay stores nothing but autocert's certificate cache; no content, keys, ids or addresses in logs (counts and close codes only).
- Nothing is queued for a side that is away: a device of an offline host is refused, a host's frame for a gone device is dropped.
- Per-connection buffer bound: 1 MiB of queued bytes; beyond it the relay applies backpressure, never grows the buffer.
- The relay's gate is only a noise filter; the end-to-end handshake (#87) is the real gate. The relay never sees a pairing secret, only a ticket id derived from it.
- Production: TLS on 443 by autocert, ACME HTTP-01 on 80; a 1 vCPU / 512 MB Ubuntu droplet, linux/amd64, `CGO_ENABLED=0`.
- Public repository: no domain, IP, host id or key in tracked files. No deploy scripts, systemd units or image publishing here: the repository ships `relay/Dockerfile` and a `docker run` example; CI builds the image and pushes nothing.
- One device key may be paired with several hosts: the relay treats each (host, device) admission independently; a phone opens one connection per host.
- `main` rules: issue #86, squash-merged PR, CI green. The first Go code adds Go build and tests to CI.

## Wire protocol (decided here; #87 and #88 implement the other ends)

Written out in full in `relay/PROTOCOL.md` (Task 4). Summary the tasks rely on:

- Endpoints: `GET /v1/host` (host connector), `GET /v1/device?host=<hostId>` (phone), `GET /healthz` (`ok`).
- Ids: `hostId` = base64url without padding of the host's 32-byte X25519 public key. A device is known to the relay by `deviceHash` = base64url(SHA-256(device public key)).
- Admission, both endpoints: the relay's first message is text JSON `{"t":"challenge","eph":<b64u 32 B>,"nonce":<b64u 32 B>}` (a fresh relay X25519 key pair and nonce per connection). The client answers within 10 s with `{"t":"hello","key":<b64u own public key>,"proof":<b64u>, ...}` where `proof` = HMAC-SHA256(key = X25519(own private, eph), message = `"nb-relay-v1 host"` or `"nb-relay-v1 device"` ‖ nonce). The relay recomputes it with X25519(eph private, key) and compares in constant time.
- Host hello adds `"devices":[deviceHash…]` (at most 32) and optionally `"ticket":<b64u 32 B>` (a pairing ticket id). The relay answers `{"t":"ok"}`. A second admitted host with the same id replaces the first (closed with 4409).
- Device hello adds optionally `"ticket"`. Admitted when its hash is in the host's list, or its ticket equals the host's current ticket. Answer `{"t":"ok","conn":<n>}`.
- Optional admission hook: when `Options.Admit` is set and returns false for a proven host id, the host is closed with 4403 and never registered.
- Host → relay text, any time after `ok`: `{"t":"devices","devices":[…]}` (replaces the list; connected devices no longer in it and not admitted by the current ticket are closed with 4403), `{"t":"ticket","ticket":<b64u>|null}`, `{"t":"close","conn":n}` (closes that device with 4403).
- Relay → host text: `{"t":"open","conn":n,"device":<deviceHash>}` when a device is admitted, `{"t":"gone","conn":n}` when it leaves.
- Binary frames: device → relay carries the payload only; relay → host prepends the 4-byte big-endian `conn`. Host → relay carries the 4-byte `conn` then the payload; relay → device strips it. Unknown `conn`: dropped. Max message 1 MiB + 4 bytes.
- Close codes: 4400 malformed or late hello, 4401 proof failed, 4403 not allowed (a device not in the list or removed; a host refused by `Admit`), 4404 host offline (device side; also sent to every device when its host leaves), 4408 too slow (a device whose queue stayed full 10 s), 4409 replaced by a newer host connection, 4413 message too large, 4429 limit reached (hosts or devices per host).
- Keepalive: the relay pings every 30 s and closes a side that has not answered within 60 s.

## Review Focus

1. A host that reconnects while its devices are still connected: the old host's devices get 4404, the new host starts with no devices; nothing from the old connection leaks into the new one (Task 2 test `TestHostReplaceClosesOldDevices`).
2. A slow phone on mobile data while the host streams a video: the relay's memory stays bounded and the other devices of the host keep getting frames until the slow one is cut with 4408 (Task 3 tests).
3. A device that connects before the host or after it left: refused at once with 4404, not held open (Task 2 test `TestDeviceHostOffline`).
4. Garbage or a never-answering client: closed with 4400 within the hello deadline, and pending handshakes do not pile up (Task 3 test `TestHelloTimeout`, Task 3 limit on pending connections).
5. A revoked phone that is connected right now: the host's new device list cuts it at once with 4403 (Task 2 test `TestDevicesUpdateKicksRemoved`).

---

## File Structure

```
relay/
  go.mod, go.sum
  PROTOCOL.md              the wire protocol above, for #87/#88
  README.md                build, run locally, run the container
  cmd/nb-relay/main.go     flags, TLS/autocert or plain loopback, /healthz, logger
  internal/relay/
    auth.go                challenge, proof, ids
    auth_test.go
    hub.go                 hosts, devices, admission, routing, close codes
    hub_test.go
    queue.go               bounded byte queue with backpressure
    queue_test.go
    server.go              http.Handler: /v1/host, /v1/device, /healthz; limits, keepalive
    testclient_test.go     test helpers: in-process host and device clients
  Dockerfile               multi-stage build, distroless static, non-root
  .dockerignore
.github/workflows/ci.yml   new job `relay`
```

### Task 1: Module, admission proof and CI

**Files:**
- Create: `relay/go.mod`, `relay/internal/relay/auth.go`, `relay/internal/relay/auth_test.go`
- Modify: `.github/workflows/ci.yml` (new job `relay`)

**Interfaces:**
- Produces:
  - `type Challenge struct { EphPub [32]byte; Nonce [32]byte; ephPriv [32]byte }`
  - `func NewChallenge() (Challenge, error)`
  - `func (c Challenge) Verify(role string, pub [32]byte, proof []byte) bool` (`role` is `"host"` or `"device"`)
  - `func Proof(role string, priv [32]byte, ephPub [32]byte, nonce [32]byte) []byte` (the client side; tests and #87 use it)
  - `func HostID(pub [32]byte) string`, `func DeviceHash(pub [32]byte) string`, `func decodeKey(s string) ([32]byte, error)` (base64url, no padding, exactly 32 bytes)

- [ ] **Step 1: Write the failing tests** in `auth_test.go`: `TestProofRoundTrip` (a key pair's `Proof` passes `Verify` for its role), `TestProofWrongRole` (a host proof fails as `"device"`), `TestProofWrongKey` (another public key fails), `TestProofOtherChallenge` (a proof for one challenge fails another), `TestIDs` (`HostID` is 43 chars of base64url; `DeviceHash` equals base64url(SHA-256(pub)); `decodeKey` refuses 31 and 33 bytes and padded input).
- [ ] **Step 2:** `cd relay && go test ./...` fails (no code).
- [ ] **Step 3:** Implement `auth.go`. The HMAC message is the ASCII label `nb-relay-v1 ` + role, then the 32 nonce bytes. Compare with `hmac.Equal`. An all-zero X25519 result is a failed proof.
- [ ] **Step 4:** `go test ./... && go vet ./...` pass; `gofmt -l .` prints nothing.
- [ ] **Step 5:** CI job `relay` on ubuntu-latest: `actions/setup-go@v5` with `go-version-file: relay/go.mod`, then in `relay/`: `test -z "$(gofmt -l .)"`, `go vet ./...`, `go test -race ./...`, `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/nb-relay ./cmd/nb-relay` (add the build line in Task 4 when `cmd/` exists), `docker build relay` (Task 5).
- [ ] **Step 6: Commit** `gh-86: relay module and the admission proof`.

### Task 2: Hub: admission, routing, close codes

**Files:**
- Create: `relay/internal/relay/hub.go`, `relay/internal/relay/server.go` (handlers only, no limits yet), `relay/internal/relay/testclient_test.go`, `relay/internal/relay/hub_test.go`

**Interfaces:**
- Consumes: Task 1's `NewChallenge`, `Verify`, `Proof`, `HostID`, `DeviceHash`.
- Produces:
  - `type Options struct { MaxHosts, MaxDevicesPerHost, MaxPending int; HelloTimeout, PingInterval, PongTimeout, SlowTimeout time.Duration; QueueBytes, MaxMessage int; Admit func(hostID string) bool; Log *slog.Logger }` with `func DefaultOptions() Options` = 1000, 16, 256, 10 s, 30 s, 60 s, 10 s, 1 MiB, 1 MiB, `Admit` nil (every proven host is admitted).
  - `func NewServer(o Options) *Server`; `func (s *Server) Handler() http.Handler` (routes `/v1/host`, `/v1/device`, `/healthz`); `func (s *Server) Close()`; `func (s *Server) Stats() (hosts, devices int)`.
  - Test helpers in `testclient_test.go`: `dialHost(t, url, priv, devices []string, ticket []byte) *testHost` and `dialDevice(t, url, hostID string, priv, ticket []byte) (*testDevice, error)`, each completing the challenge; `testHost.next()` returns the next text or binary message; close codes are read with `websocket.CloseStatus`.

- [ ] **Step 1: Write the failing tests** (`httptest.NewServer(NewServer(DefaultOptions()).Handler())`, `ws://` URLs):
  - `TestHostAdmitted`: a valid hello gets `{"t":"ok"}`; `Stats()` reports 1 host.
  - `TestBadProof`: a wrong proof is closed 4401; a hello that is not JSON or lacks `key` is closed 4400.
  - `TestDeviceHostOffline`: a device for an unknown host id is closed 4404 right after its proof.
  - `TestDeviceAdmittedByList` and `TestDeviceAdmittedByTicket`: the host gets `open` with the device's hash and conn; the device gets `ok` with the same conn. A device in neither is closed 4403 and the host gets nothing.
  - `TestRouting`: two devices; device A sends `[1,2,3]`, the host receives `conn_A ‖ 1,2,3`; the host sends `conn_B ‖ 9`, only device B receives `9`; a host frame for an unknown conn is dropped and the host stays connected.
  - `TestDeviceGone`: a device that closes produces `{"t":"gone","conn":n}` on the host.
  - `TestDevicesUpdateKicksRemoved`: the host sends a list without device A; A is closed 4403 and the host gets `gone`; B stays.
  - `TestTicketCleared`: after `{"t":"ticket","ticket":null}` a ticket-only device is refused 4403; one already admitted by the ticket stays until the next `devices` update omits it.
  - `TestHostCloseKick`: `{"t":"close","conn":n}` closes that device with 4403.
  - `TestHostReplaceClosesOldDevices`: a second host with the same key is admitted, the first is closed 4409, its devices are closed 4404, and a device admitted afterwards appears only on the second host.
  - `TestAdmitHook`: with `Admit` returning false for one host id that host is closed 4403 and `Stats()` stays 0; another host id is admitted.
  - `TestDeviceSeveralHosts`: one device key, listed by two different hosts, is admitted to both at once; frames on each connection reach only its own host.
  - `TestHostLeaves`: when the host disconnects every device is closed 4404 and `Stats()` returns to 0, 0.
- [ ] **Step 2:** `go test ./...` fails.
- [ ] **Step 3:** Implement. One goroutine reads each connection; writes go through a per-connection writer goroutine fed by the Task 3 queue (here a plain channel is fine; Task 3 swaps it). Conn numbers are per host, start at 1, never reused while the host connection lives. A host's state (`devices` set, `ticket`, `conns map[uint32]*device`) is guarded by one mutex per host; the host map by one mutex on the hub.
- [ ] **Step 4:** `go test -race ./...` passes.
- [ ] **Step 5: Commit** `gh-86: relay hub: admission, routing and close codes`.

### Task 3: Backpressure, limits and keepalive

**Files:**
- Create: `relay/internal/relay/queue.go`, `relay/internal/relay/queue_test.go`
- Modify: `relay/internal/relay/hub.go`, `relay/internal/relay/server.go`, `relay/internal/relay/hub_test.go`

**Interfaces:**
- Produces: `type queue struct{…}`; `func newQueue(limit int) *queue`; `func (q *queue) push(ctx context.Context, msg []byte) error` (blocks while the queued bytes plus `len(msg)` exceed `limit`, except that one message larger than `limit` alone is accepted when the queue is empty); `func (q *queue) pop(ctx context.Context) ([]byte, error)`; `func (q *queue) close()`.

- [ ] **Step 1: Write the failing tests:**
  - `queue_test.go`: `TestQueueBlocksAtLimit` (with limit 10, pushing 6 then 6 blocks until a pop), `TestQueueClose` (a blocked push and pop return an error after `close`).
  - `hub_test.go` with small options (`QueueBytes: 64 KiB`, `SlowTimeout: 300 ms`):
    - `TestSlowDeviceCut`: device A never reads; the host keeps sending 16 KiB frames to A and to B; B receives all its frames, A is closed 4408 within 2 s, the host gets `gone` for A.
    - `TestDeviceBackpressure`: the host stops reading; device A's sends block once about `QueueBytes` are queued (the device's write call does not return within 200 ms) instead of failing or growing memory.
    - `TestTooLarge`: a device frame of `MaxMessage + 1` bytes is closed 4413.
    - `TestHelloTimeout`: a client that sends nothing is closed 4400 after `HelloTimeout` (set to 200 ms).
    - `TestLimits`: with `MaxHosts: 1` a second host id is closed 4429; with `MaxDevicesPerHost: 1` a second device is closed 4429.
    - `TestPongTimeout`: with `PingInterval: 50 ms` and `PongTimeout: 150 ms` a client that does not answer pings is closed; a normal client stays connected for 500 ms.
- [ ] **Step 2:** `go test ./...` fails.
- [ ] **Step 3:** Implement. Host → device: the host's reader pushes into the device's queue with a `SlowTimeout` context; on timeout it closes that device with 4408 and carries on. Device → host: the device's reader pushes into the host's queue without a timeout, so a slow host throttles its devices. `MaxPending` bounds connections still in the challenge (a semaphore; over it the upgrade is answered 503). Read limit per connection: `MaxMessage + 4`. Keepalive with `conn.Ping` on `PingInterval` with a `PongTimeout` context.
- [ ] **Step 4:** `go test -race ./...` passes.
- [ ] **Step 5: Commit** `gh-86: relay backpressure, limits and keepalive`.

### Task 4: The binary and the protocol document

**Files:**
- Create: `relay/cmd/nb-relay/main.go`, `relay/cmd/nb-relay/main_test.go`, `relay/PROTOCOL.md`
- Modify: `.github/workflows/ci.yml` (the build line)

**Interfaces:**
- Consumes: `NewServer`, `DefaultOptions`, `Handler`, `Close`, `Stats`.
- Produces: the `nb-relay` command. Flags: `-domain` (required unless `-listen`), `-cache` (default `/var/lib/nb-relay/autocert`), `-email` (optional ACME contact), `-https` (default `:443`), `-http` (default `:80`, ACME challenge and a redirect to https), `-listen` (plain HTTP on a loopback address, for tests and local runs; refuses a non-loopback address), `-max-hosts`, `-max-devices`. Logs with `slog` text to stderr: start, stop, and once a minute the counts of hosts and devices; never ids, keys or addresses.

- [ ] **Step 1: Write the failing test** `TestListenRefusesNonLoopback` (`-listen 0.0.0.0:0` exits with an error naming loopback) and `TestHealthz` (start with `-listen 127.0.0.1:0` through a `run(args []string, ready func(addr string)) error` entry point; `GET /healthz` is `200 ok`).
- [ ] **Step 2:** `go test ./...` fails.
- [ ] **Step 3:** Implement `main.go` with `run`. Production mode: `autocert.Manager{Prompt: autocert.AcceptTOS, HostPolicy: autocert.HostWhitelist(domain), Cache: autocert.DirCache(cache)}`, TLS server on `-https` with `GetCertificate`, `-http` serving `m.HTTPHandler(nil)`. SIGINT/SIGTERM shut down within 5 s.
- [ ] **Step 4:** Write `PROTOCOL.md` from the "Wire protocol" section of this plan, with one worked example of the proof (fixed test keys, the resulting base64url values, generated by a Go test `TestProtocolExample` that prints and checks them so the document cannot drift).
- [ ] **Step 5:** `go test -race ./...`, the linux/amd64 build, and `go run ./cmd/nb-relay -listen 127.0.0.1:4795` answering `curl 127.0.0.1:4795/healthz` with `ok`.
- [ ] **Step 6: Commit** `gh-86: nb-relay binary with autocert, and the wire protocol`.

### Task 5: Container image and docs

**Files:**
- Create: `relay/Dockerfile`, `relay/.dockerignore`, `relay/README.md`
- Modify: `docs/architecture.md` (one paragraph on the relay under the remote section, or a new short section), `.github/workflows/ci.yml` (`docker build relay`)

**Interfaces:**
- `Dockerfile`: build stage `golang:1.27` with `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags=-s -w`; final stage `gcr.io/distroless/static-debian12:nonroot` (has CA certificates for ACME), the binary at `/nb-relay`, `VOLUME /cache`, `EXPOSE 8080 8443`, `ENTRYPOINT ["/nb-relay","-cache","/cache","-https",":8443","-http",":8080"]` so a run adds only `-domain <name> [-email <addr>]`. Unprivileged ports inside, mapped to 80/443 by the run.

- [ ] **Step 1:** Write the `Dockerfile` and `.dockerignore`; `docker build relay` succeeds locally when Docker is available (otherwise CI is the check), and `docker run --rm <img> -h` prints the flag list.
- [ ] **Step 2:** `README.md`: what the relay is, `go test`, a local run with `-listen`, building the image, and a run example `docker run -d --restart=always -p 80:8080 -p 443:8443 -v nb-relay-cache:/cache <image> -domain relay.example.com`, what the machine needs (a DNS name or `<ip>.sslip.io`, ports 80/443), that the certificate cache must be a persistent volume (Let's Encrypt rate limits), and that `relay/PROTOCOL.md` is the contract.
- [ ] **Step 3:** `docs/architecture.md`: the relay in two or three sentences, linking `relay/PROTOCOL.md`.
- [ ] **Step 4:** CI job `relay` gains `docker build relay` (the runner has Docker); nothing is pushed.
- [ ] **Step 5: Commit** `gh-86: relay container image and docs`.

Deploying to the author's droplet is not part of this repository: image publishing and the droplet's setup live elsewhere, done after the merge with the author's go-ahead, and verified with `/healthz` and one host plus one device run from a test client against the public name.
