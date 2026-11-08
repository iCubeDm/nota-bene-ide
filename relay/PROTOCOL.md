# Nota Bene relay protocol, version 1

The relay is a stateless WebSocket hub. A **host** (the Nota Bene server on a
computer) and its **devices** (phones) each open an outbound connection to the
relay; the relay pairs them by host id and forwards opaque binary frames. It
stores nothing and sees no content that the endpoints encrypt.

This document is the contract for the host connector and the device app. The
relay's checks below are only a noise filter against strangers and abuse. The
real authentication and confidentiality are the end-to-end handshake the two
endpoints run through the relay; the relay never sees a pairing secret, only a
ticket id derived from it.

## Transport

- `wss://relay.example.com/v1/host` for a host.
- `wss://relay.example.com/v1/device?host=<hostId>` for a device.
- `GET /healthz` answers `200` with body `ok`.
- WebSocket over HTTP/1.1. Text frames carry JSON objects with a `t` field;
  binary frames carry data. All keys, ids, nonces and proofs are **base64url
  without padding** (RFC 4648 section 5).
- When too many connections are still in the challenge phase the relay answers
  the HTTP upgrade with `503` before the WebSocket starts; retry later.

## Ids

- `hostId` = base64url of the host's 32-byte X25519 public key.
- `deviceHash` = base64url(SHA-256(device's 32-byte X25519 public key)).
  The relay knows a device only by this hash.
- A ticket is 32 random bytes (base64url), derived by the endpoints from a
  pairing secret. It admits a not-yet-listed device for as long as the host
  declares it.

## Admission (both endpoints)

1. The relay sends, as its first message, a fresh challenge:

   `{"t":"challenge","eph":<32 B>,"nonce":<32 B>}`

   `eph` is a new X25519 public key and `nonce` a new random value, per connection.

2. The client answers within **10 s** with a text `hello`:

   `{"t":"hello","key":<own X25519 public key, 32 B>,"proof":<32 B>, ...}`

   `proof` = HMAC-SHA256(key = X25519(own private key, `eph`), message =
   `"nb-relay-v1 host"` or `"nb-relay-v1 device"` followed by the 32 raw
   `nonce` bytes). The role string is ASCII, one space after `v1`, no
   terminator. The relay recomputes the secret as X25519(its ephemeral private
   key, `key`) and compares in constant time. The hello may not exceed 4096
   bytes; a larger one may end with WebSocket `1009` instead of `4400`.

3. Host hello adds `"devices":[<deviceHash>, ...]` (at most 32; absent means
   none) and optionally `"ticket":<32 B>`. On success the relay answers
   `{"t":"ok"}`. Fields not listed here are ignored (a device's `devices`).

4. Device hello adds optionally `"ticket":<32 B>`. The relay finds the host
   named by the `host` query parameter. The device is admitted when its
   `deviceHash` is in the host's list, or its ticket equals the host's current
   ticket. On success the relay answers `{"t":"ok","conn":<n>}`.

Worked example (test keys, never use them). Keys are written as 32 bytes,
the private ones for illustration only:

| Item | Value |
| --- | --- |
| device private key (bytes 0x01..0x20) | `AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA` |
| host private key (bytes 0x21..0x40) | `ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A` |
| challenge `eph` (public) | `ZLEBsdC-WocEvQePmJUAH8A-jp-VIvGI3RKNmEbUhGY` |
| challenge `nonce` (bytes 0x61..0x80) | `YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4A` |
| device public key | `B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw` |
| `deviceHash` | `qqj_9wO1CyKX9PbhNQj3JCDZb9Aeu4TLB0RJyq72QEE` |
| `hostId` (host public key) | `WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns` |
| device `proof` | `X2BJlpgFEN2Z9t7I2JL_d3lZgo0FRsi2nCTG5pOa6II` |
| host `proof` | `n7FU6_HfPhaPqmnxzofDb73cYRnRzvWyX6abvpdp3wQ` |

Both proofs use the same `eph` and `nonce`. `TestProtocolExample` in
`cmd/nb-relay` checks that these values are what the code computes and that this
table has not drifted.

A second admitted host with the same `hostId` replaces the first: the old
connection is closed with 4409 and its devices with 4404, and the new host
starts with no devices connected. One device key may be paired with several
hosts; the relay treats each (host, device) admission independently, so a
device opens one connection per host.

## Messages after `ok`

Host to relay (text, any time):

- `{"t":"devices","devices":[...]}` replaces the list (at most 32). Connected
  devices that are no longer listed, and were not admitted by a ticket the host
  still holds, are closed with 4403.
- `{"t":"ticket","ticket":<32 B>|null}` sets or clears the current ticket.
  Clearing it does not disconnect a device already admitted by it; a later
  `devices` message does, unless the device is listed.
- `{"t":"close","conn":<n>}` closes that device with 4403.

Relay to host (text):

- `{"t":"open","conn":<n>,"device":<deviceHash>}` when a device is admitted.
- `{"t":"gone","conn":<n>}` when it leaves, is cut, or is closed by the host.

`conn` is an unsigned 32-bit number, unique among one host connection's devices
(it counts up from 1) and meaningless after that connection ends. Unknown
fields and unknown `t` values from a host are ignored; invalid JSON or a bad
field closes the host with 4400. Text sent by a device after `ok` is ignored.

Binary frames carry the end-to-end traffic:

- Device to relay: the payload only. Relay to host: the 4-byte big-endian
  `conn` followed by the payload.
- Host to relay: the 4-byte `conn` followed by the payload. Relay to device:
  the payload only.
- A frame from the host for an unknown or departed `conn`, or shorter than 4
  bytes, is dropped. Nothing is queued for an absent side: a device of an
  offline host is refused, and frames queued for a peer are dropped when it
  closes.
- A device message may be at most `MaxMessage` (1 MiB) bytes; a host frame at
  most `MaxMessage` + 4. Anything one byte larger closes the sender with 4413.

## Flow control

Each connection has an outgoing queue of at most 1 MiB of binary data (control
messages are small and sit outside that bound). When the target's queue is
full the relay stops reading from the sender, so TCP backpressure reaches it;
it never drops data to make room. A device whose queue stays full for 10 s while
the host streams to it is closed with 4408, and the host and its other devices
carry on. A device sending to a slow host just waits.

## Keepalive

The relay sends a WebSocket ping every 30 s and closes a peer that has not
answered within 60 s with 4408. Clients answer pings as WebSocket libraries do
by default; they need not ping themselves.

## Close codes

| Code | Meaning |
| --- | --- |
| 4400 | Malformed hello, wrong first message, or hello not received within 10 s; also malformed host control messages |
| 4401 | Proof failed |
| 4403 | Not allowed: device not in the list or removed, or the host closed it; also a host refused by the relay's admission hook |
| 4404 | Host offline (device side); also sent to every device when its host leaves or is replaced |
| 4408 | Too slow or unresponsive: a device whose queue stayed full for 10 s, or a peer that failed keepalive |
| 4409 | Replaced by a newer connection of the same host |
| 4413 | Message too large |
| 4429 | Limit reached: too many hosts, or too many devices for this host |

The relay going down closes connections with `1001`, or drops them without a
close frame; reconnect with backoff. A client that is closed with 4403, 4401
or 4413 should not retry unchanged.
