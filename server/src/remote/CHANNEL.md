# Nota Bene end-to-end channel, version 1

The phone and the host connector (`nota-bene remote`) talk through the relay
(`relay/PROTOCOL.md`), which forwards their binary frames without reading
them. This document is the contract for what those frames contain: the
handshake, the pairing, the streams. The Node side lives in this folder; the
phone's implementation must pass the same tests and worked examples.

## Handshake

- Pattern and suite: `Noise_IK_25519_ChaChaPoly_SHA256`, per the Noise
  specification revision 34. The phone is the **initiator** and pins the
  host's static key from the pairing QR (or from its saved pairing); the host
  is the **responder** and learns the phone's static key from message 1.
- Prologue: the 9 ASCII bytes `nb-e2e-v1`.
- One Noise message per WebSocket binary message (relay frame payload), at
  most 65535 bytes. Message 1 goes phone → host, message 2 host → phone; every
  later message is a transport message carrying one stream frame (see
  Streams). The phone sends with the first key of `Split()`, the host with
  the second. Nonces count up from 0 on each side; there is no rekey and no
  reordering (the relay keeps order).
- A message that fails to decrypt ends the channel: the receiver drops the
  connection and the phone reconnects with a fresh handshake.
- Handshake payloads are described under Payloads.
- `noise-vectors.json` holds the official test vectors for this suite; an
  implementation must reproduce every ciphertext and the handshake hash.

## Pairing

`nota-bene remote pair` shows a QR code holding this URI:

`nbremote://pair?v=1&r=<relay URL, percent-encoded>&h=<hostId>&s=<pairing secret>`

- `r`: the relay, `wss://…` (or `ws://127.0.0.1:<port>` / `ws://localhost:<port>`
  for local runs). `h`: the host's static public key, base64url (it is also
  the relay's `hostId`). `s`: 32 random bytes, base64url, valid for 5
  minutes and for one phone only.
- While the pairing is in flight the host gives the relay the ticket
  `HMAC-SHA256(key = secret, "nb-relay-ticket-v1")`; the phone connects to the
  relay with the same ticket (the relay never sees the secret).
- In handshake message 1 the phone sends the proof
  `HMAC-SHA256(key = secret, "nb-pair-v1" ‖ phone's 32-byte static public key)`.
  The labels are ASCII without a terminator.
- Both sides show fingerprints for comparison: the first 10 bytes of
  SHA-256(public key) in lowercase base32 (RFC 4648 alphabet), as four groups
  of four joined by `-`.

Worked example (test values, never use them; the device key is the one of
`relay/PROTOCOL.md`'s example, private bytes 0x01..0x20). `store.test.ts`
checks this table against the code.

| Item | Value |
| --- | --- |
| pairing secret (bytes 0x41..0x60) | `QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2A` |
| device public key | `B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw` |
| relay ticket | `DDKWMnMYXab17ezikDLd7uircFsUBcu40ksUtkI0_Jg` |
| pairing proof | `YRz0Sr3BMUsRN5L4FiM1AYx_uBwdAmnmW9zZrBBXqxE` |
| device fingerprint | `vkup-75yd-wufs-ff7u` |

## Streams

The plaintext of every transport message is one frame:

`type u8 | stream u32 big-endian | flags u8 | body`

| Type | Name | Body |
| --- | --- | --- |
| 1 | `OPEN` | JSON: what to open (see Stream kinds). Only the phone opens streams, with odd ids counting up from 1. |
| 2 | `HEAD` | JSON: a response head (`{status, headers}` for HTTP). |
| 3 | `DATA` | Bytes. Flags: bit 0 `FIN` ends one message, bit 1 `BIN` marks a binary WebSocket message. |
| 4 | `END` | Empty: this side sends no more `DATA` on the stream. A stream that both sides ended is over (code 1000). |
| 5 | `CLOSE` | JSON `{code, reason?}`: the stream is over both ways; queued data is dropped. |
| 6 | `CREDIT` | u32 big-endian: more bytes the sender may send. Stream 0 is the connection. |

A message larger than a frame is split into `DATA` chunks, `FIN` on the last;
an empty message is one empty `DATA` frame with `FIN`. The flags byte is 0 for
every type except `DATA`.

Flow control, as in HTTP/2: each stream starts with a window of 262144 bytes
(256 KiB) of `DATA` bodies in each direction and the connection with 524288
(512 KiB) for all streams together. A sender stops when either is used up; a
receiver grants more with `CREDIT` as its consumer finishes with the data
(this side grants once half a window has been consumed). Sending more than
granted is a protocol error: the receiver closes every stream with 4900 and
drops the connection. At most 64 streams are open per channel; more are
refused with `CLOSE` 4929.

| Code | Meaning |
| --- | --- |
| 1000 | Both sides ended the stream |
| 4900 | Bad frame, bad request or credit exceeded |
| 4902 | The window could not be reached |
| 4904 | No such window, or the window has gone (restarted or closed) |
| 4913 | A message larger than the receiver accepts (64 MiB here) |
| 4929 | Too many streams |

A WebSocket stream passes the window's own close code instead (for example
4001 when another tab took the window over).

Example: `DATA` on stream 1 with `FIN` carrying `hi` is `03 00000001 01 6869`.

## Payloads

Handshake payloads are UTF-8 JSON.

- Message 1 (phone → host): `{"v":1, "name"?: <device name>, "pair"?: <pairing proof, base64url>}`.
  `pair` is sent only while pairing (see Pairing).
- Message 2 (host → phone): `{"v":1, "ok":true}`.

The host answers message 1 only when the phone's static key is in its device
list, or when `pair` matches the pairing in flight and the code has not been
used yet. Otherwise it sends nothing and closes the relay connection; the
phone sees the relay's close (4403) and shows that it is not paired.

## Stream kinds

The `OPEN` body names what the stream is:

- `{"kind":"host"}`: the host's own stream. The host sends one message
  `{"t":"windows","windows":[{port, provider, root, title?, session?, model?, busy?, supervised?}]}`
  when the stream opens and again whenever the list or a field changes (it
  checks every 5 s while the stream is open). The phone sends nothing on it.
  The channel being up is the host's online state.
- `{"kind":"ws","port":n,"path":"/ws?tab=<id>…"}`: a WebSocket to that
  window, exactly as a browser tab would open it (the one-tab rule applies).
  Every `DATA` message is one WebSocket message (`BIN` for binary). The
  window's close code comes back in `CLOSE`; a window that went away or
  refused the connection closes the stream with 4904, and the phone opens a
  new one once the host stream lists the window again.
- `{"kind":"http","port":n,"method":"GET"|"HEAD"|"POST"|"PUT"|"PATCH"|"DELETE","path":"/…","headers"?:{…}}`:
  one request. The phone sends the body as `DATA` (any chunking) and then
  `END`, also when there is no body. The host answers with `HEAD`
  `{"status":n,"headers":{…}}`, the response body as `DATA`, and `END`.
  Request headers passed on: `accept`, `content-type`, `range`, `if-none-match`,
  `if-range`, `if-modified-since`; others are dropped (the host adds the
  window's credentials). `set-cookie` never comes back. Refused with `CLOSE`
  4900: a path that does not start with `/`, starts with `//`, holds
  whitespace or `\`, or is under `/control/`. A request body may hold at most
  32 MiB (4913 beyond).

An unknown `port` closes the stream with 4904.
