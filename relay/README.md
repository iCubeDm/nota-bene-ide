# nb-relay

The Nota Bene remote-control relay: a stateless WebSocket hub. A host (the Nota
Bene server on a computer) and its devices (phones) each open an outbound
connection; the relay pairs them by host id and forwards opaque frames. It
stores nothing except the certificate cache that automatic TLS needs, and it
logs only counts and close codes.

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
go run ./cmd/nb-relay -listen 127.0.0.1:8080
curl http://127.0.0.1:8080/healthz   # ok
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

## Container image

The image is not published; build it yourself:

```sh
docker build -t nb-relay relay
docker run -d --restart=always -p 80:8080 -p 443:8443 \
  -v nb-relay-cache:/cache nb-relay -domain relay.example.com
```

Inside the container the relay listens on the unprivileged ports 8080 (HTTP)
and 8443 (HTTPS) and keeps its certificate cache in `/cache`; the run above
maps them to 80 and 443. Add `-email you@example.com` for an ACME contact.
The image is a static linux/amd64 binary on a distroless nonroot base.
