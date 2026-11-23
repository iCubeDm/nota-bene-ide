# Nota Bene end-to-end channel, version 1

The phone and the host connector (`nota-bene remote`) talk through the relay
(`relay/PROTOCOL.md`), which forwards their binary frames without reading
them. This document is the contract for what those frames contain: the
handshake, the pairing, the streams. The Node side lives in this folder; the
phone's implementation (`mobile/channel`) passes the same vectors and worked
examples, and `mobile/channel/test/cross_test.dart` runs it against the real
relay and connector through `crossHost.ts`. Another computer's connector can
be the device too (`hostLink.ts`, with its own `device.key`): what is said
here of the phone holds for it, and message 1 carries that computer's name.

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
- Message 2 (host → phone): `{"v":1, "ok":true, "host"?: <computer name>}`. `host` is what the
  computer calls itself (`os.hostname()` without a trailing `.local`), sent on every connection so the phone can
  label the host and a pairing made before it existed learns it; a host that sends none keeps the phone's fallback
  label, and a phone ignores fields it does not know.

The host answers message 1 only when the phone's static key is in its device
list, or when `pair` matches the pairing in flight and the code has not been
used yet. Otherwise it sends nothing and closes the relay connection; the
phone sees the relay's close (4403) and shows that it is not paired.

## Stream kinds

The `OPEN` body names what the stream is:

- `{"kind":"host"}`: the host's own stream. The host sends one message
  `{"t":"windows","windows":[{id?, port, provider, root, title?, session?, model?, busy?, supervised?, pending?, last?, replies?, icon?}],"agents"?:[…]}`
  (`HostStreamMessage` in `shared/src/host.ts`, generated for the phone;
  `id`: the window's stable id, `<provider>:<first 16 hex of sha1(root)>`, the
  same across restarts and port changes; a second window of the same folder and
  agent gets `<id>:<port>`, the lowest port keeping the bare id. It is opaque: a
  phone keys a window by it, and by `port:<n>` when a host sends none (one before
  it). `port` only addresses the `ws` and `http` streams below. `icon`: the
  version of the folder's picture, null when it has none, left out when the host
  could not read the window that time;
  `pending`: a permission or interaction prompt awaits an answer in the window;
  `last`: `{role: "user"|"assistant", text, at}` or null, the latest user message
  or final reply of the current session as one plain line of at most 120
  characters plus `…`, `at` in ms since epoch, left out when the event has no
  time (a message restored from a stored history); `replies`: the count of final
  text blocks of the window's current history, which after a compaction is the
  compacted history, so the count can drop. The phone treats a drop as a reset
  and may miss replies that arrived after a compaction while it was away. An
  older window sends none of the three.)
  `agents` (epic 383): the servers' other agents, folders opened in a running
  server, as rows of the same shape with `agent`, the agent's id: its `ws`,
  `http` and `public` streams go to the server's `port` under `/a/<agent>`. Its
  `id` is its folder's, so a window that moves into a server keeps it. Apart
  from `windows` so that a client before them, which would open the server's
  first agent for such a row, does not list them; a host before them sends none.
  A `windows` row names its agent too (#639: every agent is under its prefix,
  the server's top is no agent's): the server's first; an older host's has none.
  when the stream opens and again whenever the list or a field changes (it
  checks every 5 s while the stream is open). The phone sends nothing on it.
  The phone ignores fields it does not know and treats every field but `port`,
  `provider` and `root` as optional; a window without those three is left out.
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
  window's credentials). `set-cookie` never comes back. A request body may
  hold at most 32 MiB (4913 beyond).
- `{"kind":"public","port":n,"method":"GET"|"HEAD","path":"/…","headers"?:{…}}`:
  as `http`, but the host adds no credentials: the window answers what it
  serves anyone (the app shell) and 401 for the rest. Another computer's
  desktop proxy (`proxy.ts`) sends a page's requests this way until the page
  logged in to the proxy. A host that does not know the kind closes it with
  4900, so an older one never answers such a request with credentials.

Path rule, for `http`, `public` and `ws` alike (`device.ts` `goodPath`). Refused with
`CLOSE` 4900: a path longer than 8192 bytes, one that does not start with `/`
or starts with `//`, one that holds anything but printable ASCII
(percent-encode the rest, as in a URL), `\` or `#`, and any path under these
prefixes (case-insensitive):

- `/control`: the connector's own control routes.
- `/remote`: pairing, revoking and switching access stay on the computer.
- `/system/projects`, `/system/folders`, `/system/agents`: the project
  switcher starts windows, creates folders and hands out other windows' logins.
- `/system/remote`: reaches the computers this one is paired with as a device.
- `/os`: Show in Finder and Open act on this computer's desktop.

A `ws` path must also be `/ws` (with an optional query).

A path under an agent's prefix, `/a/<id>/…`, is checked as the path below it: the window takes the prefix off
before its own rules too.

An unknown `port` closes the stream with 4904.

## Reconnects

- The host stream is the online state: a window is reachable while it is
  listed there. When the channel drops, the phone reconnects with the link's
  backoff (it doubles up to a cap and starts over after a connection that
  lasted a minute); a new channel opens a new host stream, which lists the
  windows again.
- A `ws` stream closed with 4904 (the window restarted or went away) is opened
  again once a host stream list sent after that close names the window, by its
  `id`, possibly on another port.
