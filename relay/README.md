# nb-relay

The Nota Bene remote-control relay: a stateless WebSocket hub. A host (the Nota
Bene server on a computer) and its devices (phones) each open an outbound
connection; the relay pairs them by host id and forwards opaque frames. It
stores nothing except the certificate cache that automatic TLS needs, and it
logs only counts and close codes: once a minute, the hosts and devices
connected and the closes the relay initiated in that minute by role and code
(`closes="device/4408=2 host/4409=1"`).

The hub itself is the Go package `relay/hub`, which another program can embed
with its own `Options` (for example an `Admit` hook).

[PROTOCOL.md](PROTOCOL.md) is the contract for the host connector and the
device app. The relay's checks are only a noise filter against strangers and
abuse; end-to-end security is the paired host-to-phone handshake, which the
relay cannot read.

## Test

```sh
cd relay
go vet ./...
go test -race ./...
```

## Run locally

`-listen` serves plain HTTP and accepts loopback addresses only:

```sh
go run ./cmd/nb-relay -listen 127.0.0.1:4790
curl http://127.0.0.1:4790/healthz   # ok
```

## Run in production

The relay terminates TLS itself with Let's Encrypt (ACME HTTP-01 on port 80,
HTTPS on 443). The machine needs:

- a DNS name pointing at it (or `<ip>.sslip.io` for the machine's public IP);
- ports 80 and 443 reachable from the internet;
- a persistent certificate cache. Let's Encrypt rate-limits issuance, so a
  cache that is lost on every restart will eventually be refused new
  certificates. Keep `/cache` on a volume.

Flags: `-domain` (required), `-email` (optional ACME contact), `-cache`,
`-https`, `-http`, `-max-hosts`, `-max-devices`; run the binary with `-h` for
defaults.

Memory: each connection's outgoing queue holds at most 1 MiB, and the whole
relay at most 256 MiB of data in transit; beyond that senders wait and new
connections are refused with 4429 (see PROTOCOL.md, Default limits). Leave
headroom above the budget for connection state and the Go runtime; the
container image sets `GOMEMLIMIT=400MiB`.

## Container image

The image is not published; build it yourself:

```sh
docker build -t nb-relay relay
docker run -d --restart=always -p 80:8080 -p 443:8443 \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v nb-relay-cache:/cache nb-relay -domain relay.example.com
```

Inside the container the relay listens on the unprivileged ports 8080 (HTTP)
and 8443 (HTTPS) and keeps its certificate cache in `/cache`; the run above
maps them to 80 and 443. Add `-email you@example.com` for an ACME contact.
The `--log-opt` flags cap the container's log files. The relay runs as uid
65532: a named volume, as above, gets the right owner from the image, but a bind
mount of a host directory needs `chown 65532:65532` on that directory first.

The image is a static binary on a distroless nonroot base, built for the
target architecture (`docker buildx build --platform linux/arm64 ...` for
arm64; amd64 by default).
