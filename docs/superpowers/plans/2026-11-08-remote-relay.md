# Remote relay Implementation Plan

**Goal:** A stateless Go relay in `relay/` that pairs one host connector with its devices by host id and forwards their encrypted bytes, plus a container image recipe (issue #86, part of #63).

**Approach:** One static binary. Hosts and devices connect over WebSocket (TLS by autocert in production, plain on loopback in tests). Each side first proves possession of its X25519 key; the host also hands the relay the hashes of its paired device keys and, while pairing, one ticket id. After admission the relay forwards binary frames: a device's frames go to its host prefixed with a connection number, the host's frames go to the device the prefix names. Nothing is stored, queued past a small bound, or logged beyond counts.

**Stack:** Go 1.27 (module `github.com/iCubeDm/nota-bene-ide/relay`), `github.com/coder/websocket`, `golang.org/x/crypto` (`curve25519`, `acme/autocert`), `testing` with `httptest`; multi-stage `Dockerfile` (distroless static, non-root).

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md` (Shape, Identity/pairing/channel, What goes through the channel, Deployment).

## Constraints

- The relay stores only autocert's certificate cache; no content, keys, ids or addresses in logs (counts and close codes only).
- Nothing is queued for an absent side: a device of an offline host is refused; a host's frame for a gone device is dropped.
- Per-connection buffer bound 1 MiB; beyond it backpressure, never growth.
- The relay's gate is only a noise filter; the end-to-end handshake (#87) is the real gate. The relay never sees a pairing secret, only a ticket id derived from it.
- Production: TLS on 443 by autocert, ACME HTTP-01 on 80; 1 vCPU / 512 MB Ubuntu droplet, linux/amd64, `CGO_ENABLED=0`.
- Public repo: no domain, IP, host id or key in tracked files. No deploy scripts, systemd units or image publishing; the repo ships `relay/Dockerfile` and a `docker run` example; CI builds the image and pushes nothing.
- One device key may be paired with several hosts: each (host, device) admission is independent; a phone opens one connection per host.
- Squash-merged PR for issue #86; the first Go code adds Go build and tests to CI.

## Wire protocol (decided here; #87 and #88 implement the other ends)

Written in full in `relay/PROTOCOL.md`, with a worked proof example generated and checked by a Go test (`TestProtocolExample`) so the document cannot drift.

- Endpoints: `GET /v1/host`, `GET /v1/device?host=<hostId>`, `GET /healthz` (`ok`).
- Ids: `hostId` = base64url (no padding) of the host's 32-byte X25519 public key. `deviceHash` = base64url(SHA-256(device public key)).
- Admission, both endpoints: the relay first sends text JSON `{"t":"challenge","eph":<b64u 32 B>,"nonce":<b64u 32 B>}` (fresh relay X25519 key and nonce per connection). The client answers within 10 s with `{"t":"hello","key":<b64u own public key>,"proof":<b64u>, ...}` where `proof` = HMAC-SHA256(key = X25519(own private, eph), message = `"nb-relay-v1 host"` or `"nb-relay-v1 device"` || nonce). The relay recomputes with X25519(eph private, key), compares in constant time; an all-zero X25519 result fails.
- Host hello adds `"devices":[deviceHash…]` (at most 32) and optionally `"ticket":<b64u 32 B>`. Answer `{"t":"ok"}`. A second admitted host with the same id replaces the first (closed 4409).
- Device hello optionally adds `"ticket"`. Admitted when its hash is in the host's list or its ticket equals the host's current ticket. Answer `{"t":"ok","conn":<n>}`.
- Optional `Options.Admit` hook: false for a proven host id closes it with 4403, never registered.
- Host to relay text after `ok`: `{"t":"devices","devices":[…]}` (replaces the list; connected devices no longer in it and not admitted by the current ticket close 4403), `{"t":"ticket","ticket":<b64u>|null}`, `{"t":"close","conn":n}` (4403).
- Relay to host text: `{"t":"open","conn":n,"device":<deviceHash>}` on admission, `{"t":"gone","conn":n}` on leave.
- Binary frames: device to relay is the payload only; relay to host prepends a 4-byte big-endian `conn`. Host to relay carries `conn` then payload; relay to device strips it. Unknown `conn` dropped. Max message 1 MiB + 4.
- Close codes: 4400 malformed or late hello, 4401 proof failed, 4403 not allowed (device not listed or removed; host refused by `Admit`), 4404 host offline (also sent to every device when its host leaves), 4408 too slow (queue full 10 s), 4409 replaced by a newer host connection, 4413 too large, 4429 limit reached (hosts or devices per host).
- Keepalive: ping every 30 s; a side silent for 60 s is closed.

## Review focus

1. Host reconnects while devices are connected: the old host's devices get 4404, the new host starts with none; nothing leaks across (`TestHostReplaceClosesOldDevices`).
2. Slow phone while the host streams video: memory stays bounded, other devices keep getting frames until the slow one is cut with 4408.
3. A device connecting before the host or after it left is refused at once with 4404 (`TestDeviceHostOffline`).
4. Garbage or silent clients are closed 4400 within the hello deadline; pending handshakes are bounded (`TestHelloTimeout`, `MaxPending`).
5. A revoked phone connected right now is cut at once with 4403 by the host's new list (`TestDevicesUpdateKicksRemoved`).

## Layout

```
relay/
  go.mod, go.sum
  PROTOCOL.md              wire protocol, for #87/#88
  README.md                build, run locally, run the container
  cmd/nb-relay/main.go     flags, TLS/autocert or loopback, /healthz, logger
  internal/relay/
    auth.go                challenge, proof, ids
    hub.go                 hosts, devices, admission, routing, close codes
    queue.go               bounded byte queue with backpressure
    server.go              http.Handler: /v1/host, /v1/device, /healthz; limits, keepalive
    *_test.go, testclient_test.go   tests and in-process host/device clients
  Dockerfile, .dockerignore
.github/workflows/ci.yml   new job `relay`
```

## Design

**Auth** (`auth.go`): `Challenge{EphPub, Nonce, ephPriv}`, `NewChallenge`, `Challenge.Verify(role, pub, proof)`, `Proof(role, priv, ephPub, nonce)` (the client side, used by tests and #87), `HostID`, `DeviceHash`, `decodeKey` (base64url, no padding, exactly 32 bytes). Compare with `hmac.Equal`. Tests: round trip, wrong role, wrong key, other challenge, id formats.

**Hub and server** (`hub.go`, `server.go`): `Options{MaxHosts, MaxDevicesPerHost, MaxPending, HelloTimeout, PingInterval, PongTimeout, SlowTimeout, QueueBytes, MaxMessage, Admit, Log}`; `DefaultOptions()` = 1000, 16, 256, 10 s, 30 s, 60 s, 10 s, 1 MiB, 1 MiB, `Admit` nil. `NewServer(o)`, `Handler()`, `Close()`, `Stats()`. One reader goroutine per connection; writes go through a per-connection writer fed by the queue. Conn numbers are per host, start at 1, never reused while the host connection lives. Per-host mutex guards `devices`, `ticket`, `conns`; one hub mutex guards the host map. Tests cover host admission, bad proof (4401) and malformed hello (4400), device with host offline (4404), admission by list and by ticket (else 4403, host gets nothing), routing both ways with dropped unknown conn, `gone`, list update kicking removed devices, ticket clearing (already-admitted device stays until the next list omits it), host `close`, host replacement, `Admit` hook, one device key on two hosts, host leaving (all devices 4404, stats back to 0).

**Backpressure, limits, keepalive** (`queue.go`): `newQueue(limit)`, `push(ctx, msg)` blocks while queued bytes plus the message exceed `limit` (one message larger than `limit` is accepted when the queue is empty), `pop`, `close`. Host to device: the host's reader pushes with a `SlowTimeout` context; on timeout it closes that device 4408 and carries on. Device to host: pushed without a timeout, so a slow host throttles its devices. `MaxPending` is a semaphore over connections in the challenge (over it the upgrade is answered 503). Read limit `MaxMessage + 4` (over it 4413). Keepalive via `conn.Ping` on `PingInterval` with a `PongTimeout` context. Tests with small options: slow device cut while the other receives all frames, device backpressure blocks writes instead of growing memory, too large, hello timeout, limits (4429), pong timeout.

**Binary** (`cmd/nb-relay`): flags `-domain` (required unless `-listen`), `-cache` (default `/var/lib/nb-relay/autocert`), `-email`, `-https` (`:443`), `-http` (`:80`, ACME challenge plus redirect), `-listen` (plain HTTP, refuses a non-loopback address), `-max-hosts`, `-max-devices`. `run(args, ready)` entry point for tests. Production: `autocert.Manager` with `HostWhitelist(domain)` and `DirCache`, TLS with `GetCertificate`, `-http` serves `m.HTTPHandler(nil)`. SIGINT/SIGTERM shut down within 5 s. `slog` text to stderr: start, stop, a once-a-minute count of hosts and devices; never ids, keys or addresses.

**Image** (`Dockerfile`): build stage `golang:1.27` (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags=-s -w`); final `gcr.io/distroless/static-debian12:nonroot` (has CA certificates for ACME), binary `/nb-relay`, `VOLUME /cache`, `EXPOSE 8080 8443`, entrypoint `/nb-relay -cache /cache -https :8443 -http :8080`, so a run adds only `-domain <name> [-email <addr>]`; ports mapped to 80/443 by the run.

## CI and docs

CI job `relay` (ubuntu-latest, `actions/setup-go@v5` from `relay/go.mod`), in `relay/`: `gofmt -l` empty, `go vet ./...`, `go test -race ./...`, linux/amd64 static build, `docker build relay` (nothing pushed). `relay/README.md`: what the relay is, `go test`, local run with `-listen`, building the image, run example `docker run -d --restart=always -p 80:8080 -p 443:8443 -v nb-relay-cache:/cache <image> -domain relay.example.com`, machine needs (a DNS name or `<ip>.sslip.io`, ports 80/443), the certificate cache must be a persistent volume (Let's Encrypt rate limits), `PROTOCOL.md` is the contract. `docs/architecture.md`: two or three sentences on the relay linking `relay/PROTOCOL.md`.

Deployment to the author's droplet is not part of this repository: image publishing and droplet setup happen elsewhere after merge with the author's go-ahead, verified with `/healthz` and one host plus one device from a test client against the public name.
