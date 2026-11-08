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
