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
