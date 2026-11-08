# Remote app shell (#88) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Android Flutter app that pairs with a host by QR, keeps one end-to-end channel per paired host through the relay, lists each host's windows, and works in a window's chat as an ordinary tab: read, send, answer approvals and questions, stop, compact, switch model and effort, restart the agent, take the window over.

**Architecture:** Two Dart packages next to the existing `mobile/protocol` (`nb_protocol`): `mobile/channel` (`nb_channel`, pure Dart: Noise IK, pairing values, the relay's device admission, the stream mux, the channel) and `mobile/app` (`nb_app`, Flutter: storage, lock, pairing, host links, screens). The channel package is a port of `server/src/remote/` and is proved against the same vectors and worked examples, then end to end against the real Go relay and the real Node connector. The app keeps no state library: plain `ChangeNotifier` models with `ListenableBuilder`, and every platform plugin behind a small interface so widget tests run on the host VM.

**Tech Stack:** Dart 3.8+, Flutter 3.47 stable; `cryptography` 2.9 (X25519, ChaCha20-Poly1305, SHA-256, HMAC); `web_socket_channel` 3; `flutter_secure_storage` 11 (Android Keystore); `local_auth` 3 (BiometricPrompt with device credential); `mobile_scanner` 7; `flutter_markdown_plus` 1 (the maintained fork; `flutter_markdown` is discontinued); `highlight` 0.7; `flutter_math_fork` 0.7; `mermaid_flutter` 0.3 (pure Dart; `merman` is FFI and was rejected); `flutter_localizations` + ARB.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-prototype-design.md`. Contracts: `server/src/remote/CHANNEL.md`, `relay/PROTOCOL.md`, `shared/src/protocol.ts` (via `mobile/protocol`).

## Global Constraints

- Phone: Android only. Hosts: macOS and Linux. Relay URLs `wss://…`, or `ws://127.0.0.1:<port>` / `ws://localhost:<port>` for local runs (as `parsePairUri` accepts on the host).
- "every UI language for every user-visible string. This applies to the Flutter app too (six languages, as `LANGS`)": `en, ru, zh-CN, es, pt-BR, de` (`shared/src/lang.ts` `UI_LANGS`).
- "App strings: Flutter's ARB files, one per language of `LANGS`; a test fails when the files' keys differ."
- "Look: the Nota Bene themes' tokens; Darcula first." Values come from `web/src/theme.css` `:root, [data-theme="darcula"]`.
- "a homemade cipher or handshake" is an anti-goal: the primitives come from `cryptography`; the Noise state machine is the spec's, checked against `server/src/remote/noise-vectors.json`.
- The phone never holds a window key, cookie or token; it sends only `accept`, `content-type`, `range`, `if-none-match`, `if-range`, `if-modified-since` on `http` streams.
- Phone key: long-term X25519, stored with Android Keystore-backed storage, never exported, never logged.
- "the app opens only after the phone's biometric or PIN check (Android BiometricPrompt)".
- Host offline: "a status line with the last-seen time; what already arrived stays readable; sending is disabled, not deferred."
- Window ownership: the phone is an ordinary tab (`/ws?tab=<id>`); occupied → "Work here" sends `{type:'takeover'}`; after 4001 the same overlay takes it back.
- Tests and smoke use ports 4790–4795 only; a temp `NOTA_BENE_HOME`; never `~/.nota-bene`.
- Public repo: neutral fixtures, no personal hosts, domains or keys.
- PR titles and commits `gh-88: …`, squash into `remote`.

## Delivery

Two PRs into `remote`, both `gh-88: …`: **PR A** = Tasks 1–7 (channel, cross-language proof, app skeleton, storage and lock, pairing, host list); **PR B** = Tasks 8–11 (window tab, chat, controls, docs). PR A is usable on its own (pair, see windows) and keeps each review to a reviewable size.

## Not in #88 (other children of #63)

Comments on chat and files (#89), images and video (#90), usage statistics (#91), dictation (#92), session switching inside a window (`/sessions` picker), `/clear`, mode switching, shell commands. The chat renders a comment-less feed; the composer sends plain text.

## Review Focus

1. **Network change or Android killing the socket mid-turn** (Wi-Fi → mobile, screen off): the link reconnects with backoff, the ws stream reopens with the *same* tab id (the server gives the owner role back at once, no 700 ms occupied flash), and the feed is rebuilt from the replay with no duplicate items. Test: Task 8 `reconnect keeps the tab id and replaces the feed`.
2. **Revoked phone:** the relay closes with 4403 on every attempt; the app shows "not paired with this host any more" and stops retrying that host instead of looping every second. Test: Task 3 cross-language `a revoked phone gets 4403`, Task 7 `4403 stops the link and marks it unpaired`.
3. **Window restarted** (stream CLOSE 4904): the tab waits for the host stream to list the port again and reopens; nothing is lost from the feed until the new replay arrives. Test: Task 8 `4904 reopens when the window is listed again`.
4. **A replay or response larger than the windows** (256 KiB stream / 512 KiB connection, messages split at 65513): credit is granted as data is consumed and the message reassembles intact. Test: Task 2 `a 1 MiB message crosses with credit`, Task 3 cross-language `GET of a 700 KiB file`.
5. **An approval answered elsewhere** (desktop tab or another phone) while the sheet is open: `permission-done` closes the sheet and marks the card answered; a second tap sends nothing. Test: Task 10 `permission-done closes the sheet`.

---

### Task 1: `nb_channel` — Noise IK and pairing values

**Files:**
- Create: `mobile/channel/pubspec.yaml` (`name: nb_channel`, `publish_to: none`, sdk `^3.8.0`, deps `cryptography: ^2.9.0`, dev `lints`, `test`), `mobile/channel/analysis_options.yaml` (copy of `mobile/protocol`'s), `mobile/channel/lib/nb_channel.dart`
- Create: `mobile/channel/lib/src/noise.dart`, `mobile/channel/lib/src/pairing.dart`
- Test: `mobile/channel/test/noise_test.dart`, `mobile/channel/test/pairing_test.dart`
- Modify: `.github/workflows/ci.yml` (`protocol` job: the same four steps for `mobile/channel`)

**Interfaces:**
- Produces (`noise.dart`): `typedef KeyPair = ({Uint8List pub, Uint8List priv})`; `Future<KeyPair> generateKeyPair()`; `Future<Uint8List> publicOf(Uint8List priv)`; `Future<Uint8List> dh(Uint8List priv, Uint8List pub)` (throws `NoiseError` on an all-zero result); `class CipherState { Future<Uint8List> encrypt(Uint8List plain, {Uint8List? ad}); Future<Uint8List> decrypt(Uint8List cipher, {Uint8List? ad}); }` (a failed decrypt throws `NoiseError` and kills the state); `class Handshake { static Future<Handshake> initiator({required KeyPair s, required Uint8List rs, Uint8List? prologue, KeyPair? e}); static Future<Handshake> responder({required KeyPair s, Uint8List? prologue, KeyPair? e}); Future<Uint8List> writeMessage([Uint8List? payload]); Future<Uint8List> readMessage(Uint8List msg); bool get done; Uint8List get handshakeHash; Uint8List? get remoteStatic; ({CipherState send, CipherState recv}) split(); }`; `const prologue = 'nb-e2e-v1'`, `maxMessage = 65535`, `maxPlaintext = 65519`. The responder side exists for the vectors and for tests.
- Produces (`pairing.dart`): `String b64u(List<int>)`, `Uint8List fromB64u(String, [int? length])`; `({Uri relay, Uint8List hostPub, Uint8List secret}) parsePairUri(String)` (throws `FormatException` with a message for the user); `Future<Uint8List> pairTicket(Uint8List secret)`, `Future<Uint8List> pairProof(Uint8List secret, Uint8List devicePub)`, `Future<String> fingerprint(Uint8List pub)`, `Future<String> deviceHash(Uint8List pub)`, `Future<Uint8List> relayProof(Uint8List priv, Uint8List eph, Uint8List nonce)` (role `device`).

- [ ] **Step 1: Write the failing tests.** `noise_test.dart`: `reproduces every vector` reads `../../server/src/remote/noise-vectors.json` (both entries), runs initiator and responder with the vector's fixed ephemerals, and expects every message ciphertext and the handshake hash byte-for-byte; `a tampered message kills the state` (flip one byte of a transport message → `NoiseError`, the next valid one also throws); `an all-zero DH is refused` (a low-order point → `NoiseError`). `pairing_test.dart`: the CHANNEL.md worked example (secret bytes 0x41..0x60 → `QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2A`; device priv 0x01..0x20 → pub `B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw`, ticket `DDKWMnMYXab17ezikDLd7uircFsUBcu40ksUtkI0_Jg`, proof `YRz0Sr3BMUsRN5L4FiM1AYx_uBwdAmnmW9zZrBBXqxE`, fingerprint `vkup-75yd-wufs-ff7u`); the relay/PROTOCOL.md example (`deviceHash` `qqj_9wO1CyKX9PbhNQj3JCDZb9Aeu4TLB0RJyq72QEE`, device `proof` `X2BJlpgFEN2Z9t7I2JL_d3lZgo0FRsi2nCTG5pOa6II` with that document's eph and nonce 0x61..0x80); `parsePairUri` accepts the URI `pairUri` produces in `store.test.ts` and rejects `http://`, `ws://example.com`, a missing `s`, a 31-byte secret, `v=2`.
- [ ] **Step 2: Run** `cd mobile/channel && dart pub get && dart test`. Expected: FAIL (no library).
- [ ] **Step 3: Implement** `noise.dart` as a line-by-line port of `server/src/remote/noise.ts` (HKDF over HMAC-SHA256, nonce = 4 zero bytes ‖ u64 LE counter, `MixHash(rs)` pre-message for the responder key), and `pairing.dart` as a port of the matching functions of `store.ts` and `relayClient.ts`. Base32 lowercase, no padding.
- [ ] **Step 4: Run** `dart analyze --fatal-infos && dart format --output=none --set-exit-if-changed lib test && dart test`. Expected: all pass.
- [ ] **Step 5: Commit** `gh-88: Noise IK and pairing values in Dart, checked against the shared vectors`.

### Task 2: `nb_channel` — the stream mux

**Files:**
- Create: `mobile/channel/lib/src/mux.dart`
- Test: `mobile/channel/test/mux_test.dart`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: the constants of `server/src/remote/mux.ts` under the same names in lowerCamel (`streamWindow`, `connWindow`, `maxChunk = 65513`, `maxStreams = 64`, `maxCollect = 64 MiB`, codes `closed=1000, badFrame=4900, unreachable=4902, unknownWindow=4904, tooLarge=4913, tooMany=4929`); `sealed class Frame` with `Open, Head, Data(fin, binary), End, Close(code, reason), Credit(n)` and `Uint8List encodeFrame(Frame)`, `Frame decodeFrame(Uint8List)` (throws `MuxError`); `class Mux { Mux(void Function(Uint8List frame) send); void receive(Uint8List frame); MuxStream open(Map<String, Object?> body); void closeAll(int code); }` (phone side: opens odd ids from 1, never accepts an `OPEN`); `class MuxStream { int get id; Stream<({Uint8List data, bool binary})> get messages; Future<Map<String, Object?>> get head; Future<({int code, String? reason})> get closed; Future<void> send(List<int> data, {bool binary = false}); void end(); void close(int code, [String? reason]); }` — `messages` reassembles `FIN`-delimited messages up to `maxCollect` (beyond: `CLOSE` 4913), and credit is granted back when the listener has taken a message (half-window rule, as the Node side).

- [ ] **Step 1: Write the failing tests:** `encodes the CHANNEL.md example` (`Data` stream 1 FIN `hi` ↔ hex `03000000010168 69`); `a 1 MiB message crosses with credit` (two Muxes wired back to back, one message of 1,048,576 bytes arrives equal, and no side ever has more than 262144 un-credited bytes in flight on the stream); `sending past the window is a protocol error` (a hand-built `Data` beyond 262144 → every stream closes with 4900); `the 65th stream is refused with 4929`; `an empty message is one empty DATA with FIN`; `a stream ended both ways closes with 1000`; `a message beyond maxCollect closes with 4913` (use a test-only smaller limit parameter).
- [ ] **Step 2: Run** `dart test test/mux_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement** `mux.dart` from `mux.ts` (connection window shared by all streams; a stream's queued data is dropped on `CLOSE`; credit returned for dropped data).
- [ ] **Step 4: Run** `dart analyze --fatal-infos && dart test`. Expected: PASS.
- [ ] **Step 5: Commit** `gh-88: stream mux in Dart with credit flow control`.

### Task 3: `nb_channel` — the channel, proved against the real relay and connector

**Files:**
- Create: `mobile/channel/lib/src/channel.dart`
- Create: `server/src/remote/crossHost.ts` (a Node script for tests only: starts `testRelay` on a free port, a window via `startServer` with `fakeBackend` on port 0 serving a temp project with `notes.md` and a 700 KiB `big.bin`, registers it, starts a `Connector` with a temp `NOTA_BENE_HOME`, then reads commands as JSON lines on stdin — `{"op":"pair"}`, `{"op":"revoke","id"}`, `{"op":"restart-relay"}`, `{"op":"stop"}` — and writes JSON lines on stdout: `{"t":"ready","relay","port"}`, `{"t":"code","uri"}`, `{"t":"paired","id"}`, `{"t":"revoked"}`, `{"t":"restarted"}`)
- Test: `mobile/channel/test/cross_test.dart` (tag `cross`), `server/src/remote/crossHost.test.ts` (runs the script once to `ready` and `code`, so a Node-side break shows up in `npm test` too)
- Modify: `.github/workflows/ci.yml` (`protocol` job: `actions/setup-go@v5` with `go-version-file: relay/go.mod`, `npm ci`, then `dart test` in `mobile/channel` runs the `cross` tag)

**Interfaces:**
- Consumes: Task 1 `Handshake`, `relayProof`, `deviceHash`, `pairProof`; Task 2 `Mux`, `MuxStream`.
- Produces: `class ChannelError implements Exception { final int? relayCode; final String message; }`; `class Channel { static Future<Channel> connect({required Uri relay, required Uint8List hostPub, required KeyPair key, Uint8List? ticket, Map<String, Object?> hello = const {'v': 1}, Duration timeout = const Duration(seconds: 15)}); Stream<List<HostWindow>> get windows; MuxStream ws(int port, String path); Future<HttpAnswer> http(int port, String method, String path, {Map<String, String>? headers, List<int>? body}); Future<int> get closed /* relay close code or 0 */; Future<void> close(); }`; `class HostWindow { int port; String provider; String root; String? title, session, model; bool busy, supervised; }` from the host stream's `windows` message; `typedef HttpAnswer = ({int status, Map<String, String> headers, Uint8List body})`. `connect` throws `ChannelError(relayCode: 4403)` when the relay refuses, `ChannelError` with the relay code for any close before message 2.

- [ ] **Step 1: Write the failing tests** in `cross_test.dart` (spawns `node server/src/remote/crossHost.ts` from the repo root, `NOTA_BENE_HOME` in a temp dir, waits for `ready`): `pairs with a QR code and lists the window` (send `pair`, parse the `uri`, connect with ticket and `pair` proof and `name: 'Test phone'`, wait for `paired`, then `windows` lists the port with provider `claude`); `reconnects with the saved pairing` (new `connect` without ticket or proof succeeds); `GET /info and a Range of notes.md` (status 200; `range: bytes=9-33` → 206); `GET of a 700 KiB file` arrives byte-equal; `a ws tab gets replay and hello` (`ws(port, '/ws?tab=<uuid>')`, the first message parses as `ServerEventReplay` via `nb_protocol`, a later one as `ServerEventHello`); `a relay restart closes the channel and a new one works`; `a revoked phone gets 4403` (send `revoke`, the open channel closes, a new `connect` throws `ChannelError` with `relayCode == 4403`). In `crossHost.test.ts`: `prints ready and a code`.
- [ ] **Step 2: Run** `cd mobile/channel && dart test -t cross`. Expected: FAIL.
- [ ] **Step 3: Implement** `crossHost.ts` from `e2e.test.ts`'s setup; `channel.dart`: open `<relay>/v1/device?host=<b64u hostPub>` with `web_socket_channel`, answer the challenge with `relayProof`, send `{t:'hello', key, proof, ticket?}`, wait for `ok`, then Noise message 1 with the JSON payload, message 2 must decode to `{"v":1,"ok":true}`, then one transport message per mux frame; open the host stream at once; `http` adds nothing but the allowed headers.
- [ ] **Step 4: Run** `dart test` (all tags) in `mobile/channel` and `npx vitest run server/src/remote/crossHost.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `gh-88: Dart channel to the host, proved against the Go relay and the Node connector`.

### Task 4: Flutter app skeleton, theme, strings, CI

**Files:**
- Create: `mobile/app/` with `flutter create --org dev.notabene --project-name nb_app --platforms android` then trimmed: no iOS/web/desktop folders, no counter demo, no `test/widget_test.dart`.
- Create: `mobile/app/lib/main.dart`, `mobile/app/lib/theme.dart`, `mobile/app/l10n.yaml`, `mobile/app/lib/l10n/app_{en,ru,zh_CN,es,pt_BR,de}.arb`
- Test: `mobile/app/test/theme_test.dart`, `mobile/app/test/l10n_test.dart`
- Modify: `mobile/app/android/app/build.gradle.kts` (`minSdk = 24`, applicationId `dev.notabene.remote`, app name "Nota Bene"), `AndroidManifest.xml` (`INTERNET`, `CAMERA`, `USE_BIOMETRIC`; `android:allowBackup="false"`), `MainActivity.kt` (extends `FlutterFragmentActivity`, required by `local_auth`), a debug-only network security config that allows cleartext to `127.0.0.1`/`localhost`/`10.0.2.2` only
- Modify: `.github/workflows/ci.yml`: a `mobile` job on ubuntu-latest: `subosito/flutter-action@v2` (channel stable, the version in `mobile/app/pubspec.yaml`'s `environment.flutter`), `flutter pub get`, `flutter analyze --fatal-infos`, `dart format --output=none --set-exit-if-changed lib test`, `flutter test`, `flutter build apk --debug`, `actions/upload-artifact@v4` of the APK (14 days)
- Modify: `.gitignore` (Flutter build outputs under `mobile/app/`)

**Interfaces:**
- Produces: `ThemeData darcula()` and `class NbColors extends ThemeExtension<NbColors>` with the token names of `theme.css` in lowerCamel (`background, foreground, card, popover, muted, mutedFg, border, borderSoft, primary, primaryFg, accent (nb-accent), destructive, success, link, codeBg, warn` and the `syn*` set); `AppLocalizations` generated by `flutter gen-l10n` (`synthetic-package: false`, output `lib/l10n/`); `Locale` resolution: the device locale mapped to `UI_LANGS` (`zh` → `zh-CN`, `pt` → `pt-BR`), otherwise `en`.

- [ ] **Step 1: Write the failing tests:** `theme_test.dart` `Darcula matches theme.css` parses the `:root, [data-theme="darcula"]` block of `../../web/src/theme.css` and expects every `NbColors` field to equal its `--token` (hex and `rgb(r g b/.a)` forms); `l10n_test.dart` `every language has the same keys` (the six ARB files' non-`@` key sets are equal and none is empty) and `the languages are UI_LANGS` (the ARB locales equal the array parsed from `../../shared/src/lang.ts`).
- [ ] **Step 2: Run** `cd mobile/app && flutter test`. Expected: FAIL.
- [ ] **Step 3: Implement** the theme (fonts: system sans and monospace; no bundled Inter/Geist), the first strings (app name, lock screen, generic errors) in all six languages, `main.dart` with a placeholder home that later tasks replace.
- [ ] **Step 4: Run** `flutter analyze --fatal-infos && flutter test`. Expected: PASS. `flutter build apk --debug` is checked in CI only (no Android SDK on the dev machine).
- [ ] **Step 5: Commit** `gh-88: Flutter app skeleton with the Darcula tokens, six languages and a CI build`.

### Task 5: Identity, paired hosts and the lock

**Files:**
- Create: `mobile/app/lib/store/vault.dart`, `mobile/app/lib/store/hosts.dart`, `mobile/app/lib/lock/lock.dart`
- Test: `mobile/app/test/hosts_test.dart`, `mobile/app/test/lock_test.dart`

**Interfaces:**
- Consumes: `nb_channel` `generateKeyPair`, `fingerprint`.
- Produces: `abstract class Vault { Future<String?> read(String key); Future<void> write(String key, String value); Future<void> delete(String key); }` with `SecureVault` (`flutter_secure_storage` with its default, Keystore-backed `AndroidOptions`) and `MemoryVault` for tests; `class Identity { static Future<Identity> load(Vault); KeyPair get key; Future<String> get fingerprint; }` (key `nb.identity`, created once); `class PairedHost { String id /* b64u hostPub */; Uri relay; String label /* basename of the first window root, editable later */; DateTime pairedAt; }`; `class Hosts extends ChangeNotifier { static Future<Hosts> load(Vault); List<PairedHost> get all; Future<void> add(PairedHost); Future<void> forget(String id); String? lastChat /* "<hostId> <port> <root>" */; Future<void> setLastChat(String?); }` (key `nb.hosts`, JSON); `abstract class Authenticator { Future<bool> authenticate(String reason); }` with `DeviceAuthenticator` (`local_auth`, `biometricOnly: false` so PIN/pattern works) and a fake; `class LockGate extends StatefulWidget` — shows the lock screen until `authenticate` returns true; locks again when the app was in the background for 5 minutes or more (`AppLifecycleListener`).

- [ ] **Step 1: Write the failing tests:** `the identity is created once and kept`; `hosts survive a reload and forget removes one`; `a corrupt nb.hosts is treated as empty and not overwritten until a change` (no crash); `LockGate shows the child only after authenticate succeeds`; `a failed check offers retry`; `5 minutes in the background locks again, 4 do not` (fake clock).
- [ ] **Step 2: Run** `flutter test test/hosts_test.dart test/lock_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** A device with no screen lock at all: `local_auth` reports it; show a screen that asks to set one in Android settings and does not open the app.
- [ ] **Step 4: Run** `flutter analyze --fatal-infos && flutter test`. Expected: PASS.
- [ ] **Step 5: Commit** `gh-88: phone identity, paired hosts and the biometric or PIN lock`.

### Task 6: Pairing by QR

**Files:**
- Create: `mobile/app/lib/pairing/scan_screen.dart`, `mobile/app/lib/pairing/pair_flow.dart`, `mobile/app/lib/pairing/confirm_screen.dart`
- Test: `mobile/app/test/pair_flow_test.dart`

**Interfaces:**
- Consumes: `parsePairUri`, `pairTicket`, `pairProof`, `fingerprint`, `Channel.connect`, `ChannelError`; Task 5 `Identity`, `Hosts`.
- Produces: `typedef ChannelFactory = Future<Channel> Function({required Uri relay, required Uint8List hostPub, required KeyPair key, Uint8List? ticket, Map<String, Object?> hello})` (the app passes `Channel.connect`; tests pass a fake); `class PairFlow { PairFlow(ChannelFactory, Identity, Hosts); Future<PairResult> pair(String qr, {required String deviceName}); }` with `sealed class PairResult`: `Paired(PairedHost host, String hostFingerprint, String phoneFingerprint)`, `PairFailed(String messageKey)`; message keys for: not a Nota Bene code, code expired or used (relay 4403), relay unreachable, host already paired (offer to keep the existing one). The device name is the Android model name (`Build.MODEL` through `device_info_plus`) or "Android phone".

- [ ] **Step 1: Write the failing tests:** `a valid code pairs and saves the host` (fake factory records `ticket` = `pairTicket(secret)` and `hello.pair` = `b64u(pairProof(secret, phonePub))`, `hello.name`); `a 4403 says the code expired or was used`; `an http:// QR is not a Nota Bene code`; `the confirm screen shows both fingerprints` (widget test: both strings visible, "Done" returns to the list).
- [ ] **Step 2: Run** `flutter test test/pair_flow_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** The scanner screen uses `mobile_scanner` and stops at the first `nbremote://` code; camera denied → a message with a button to the app's settings. The channel used for pairing is closed after `ok`; the host link (Task 7) opens its own.
- [ ] **Step 4: Run** `flutter analyze --fatal-infos && flutter test`. Expected: PASS.
- [ ] **Step 5: Commit** `gh-88: pair a host by scanning its QR code`.

### Task 7: Host links and the session list

**Files:**
- Create: `mobile/app/lib/hosts/host_link.dart`, `mobile/app/lib/hosts/hosts_screen.dart`, `mobile/app/lib/home.dart`
- Test: `mobile/app/test/host_link_test.dart`, `mobile/app/test/hosts_screen_test.dart`

**Interfaces:**
- Consumes: `ChannelFactory`, `Channel.windows`, `Channel.closed`, `HostWindow`; Task 5 `Hosts`, `Identity`.
- Produces: `enum LinkState { connecting, online, offline, unpaired }`; `class HostLink extends ChangeNotifier { HostLink(PairedHost, ChannelFactory, Identity, {Duration minBackoff = 1s, Duration maxBackoff = 30s, Clock? clock}); LinkState get state; DateTime? get lastSeen; List<HostWindow> get windows /* last known, kept while offline */; Channel? get channel; void start(); void stop(); }` — reconnect with backoff ×2 and ±20 % jitter, reset after 60 s online; 4403 → `unpaired`, no retry until `start()` again; `class Links extends ChangeNotifier { Links(Hosts, ChannelFactory, Identity); HostLink of(String hostId); }` — one link per paired host, created and disposed as `Hosts` changes; app lifecycle: links pause after 10 minutes in the background and resume on return. `HostsScreen`: one group per host (label, state dot, "offline · seen 5 min ago" or "not paired any more" with Forget), its windows as rows (project folder name, title or "untitled", provider, model, a busy dot); tap → Task 8's chat route `ChatRoute(hostId, port, root)`. `Home`: opens `Hosts.lastChat` when its host is online and still lists that port and root, otherwise `HostsScreen`; no hosts → an empty state with "Pair a host" that opens Task 6.

- [ ] **Step 1: Write the failing tests:** `backoff doubles to 30 s and resets after a minute online` (fake clock, fake factory failing then succeeding); `4403 stops the link and marks it unpaired`; `offline keeps the last windows and the last-seen time`; `the screen groups windows by host and shows an offline host as offline` (two hosts, one offline); `Home opens the last chat only when its host is online and lists it`.
- [ ] **Step 2: Run** `flutter test test/host_link_test.dart test/hosts_screen_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** Relative times through `AppLocalizations` (all six languages).
- [ ] **Step 4: Run** `flutter analyze --fatal-infos && flutter test`. Expected: PASS.
- [ ] **Step 5: Commit** `gh-88: one link per paired host and the session list grouped by host`. **PR A ends here:** open `gh-88: phone channel, pairing and the session list` into `remote`.

### Task 8: The window tab and the feed

**Files:**
- Create: `mobile/app/lib/chat/window_tab.dart`, `mobile/app/lib/chat/feed.dart`
- Test: `mobile/app/test/feed_test.dart`, `mobile/app/test/window_tab_test.dart`

**Interfaces:**
- Consumes: `nb_protocol` `ServerEvent`, `ClientMessage`, `WireAgentEvent`, `ModelOption`, `TAKEN_OVER` (4001); Task 3 `MuxStream`; Task 7 `HostLink`.
- Produces: `class Feed { List<FeedItem> items; bool busy; int earlier; Feed reduce(ServerEvent e); }` — a port of `web/src/store/feed.ts` `reduce`/`reduceAgent` for: `replay` (fresh feed), `user`, agent `message-start`/`message-chunk`/`message`, `tool-call` (one-line `arg` rule of `feed.ts:101-107`, cut at 160), `tool-update`, `turn-start`, `turn-end` (done line; busy rule), `cancelled`, `compacting`/`compact-end`/`compact-failed`/`compacted`, `reset`, `permission`/`permission-done`, `session`, `resumed`; others ignored. `sealed class FeedItem`: `UserItem, AssistantItem(text, final), ToolItem(name, arg, result?, isError), DoneItem(stop, secs, error?), MarkerItem(kind), PermissionItem(id, toolName, input, prompt?, answer?)`. `enum TabState { connecting, open, occupied, taken, gone, offline }`; `class WindowTab extends ChangeNotifier { WindowTab(HostLink, int port, String root); TabState state; Feed feed; List<ModelOption> models; String? model; AgentEffort? effort; String? title; HelloCaps? caps /* protocol, capabilities */; Stats? stats; void send(ClientMessage m); void takeOver(); void dispose(); }` — tab id `uuid v4` in memory, kept across reconnects within the object's life; `&passive=1` after `occupied` or `taken`; `open` only on `replay`; `occupied` → overlay; `takeOver()` per `store.ts:134-146`; stream CLOSE 4001 → `taken`, no reconnect; 4904 → `gone`, reopens when `HostLink.windows` lists the port again; link offline → `offline`, the feed stays; link online → reopen.

- [ ] **Step 1: Write the failing tests.** `feed_test.dart` from `shared/fixtures/protocol.json` plus hand events: `replay builds the feed`, `chunks stream into one assistant item and message finalizes it`, `tool-call shows the command as its arg`, `turn-end clears busy unless queued`, `permission-done marks the card answered`, `reset clears the feed`. `window_tab_test.dart` with a fake `MuxStream`: `open waits for the replay`; `occupied then Work here sends takeover and opens on replay`; `4001 goes to taken and does not reconnect`; `reconnect keeps the tab id and replaces the feed` (second OPEN path has the same `tab=`, no duplicate items after the second replay); `4904 reopens when the window is listed again`; `offline keeps the feed`.
- [ ] **Step 2: Run** `flutter test test/feed_test.dart test/window_tab_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `flutter analyze --fatal-infos && flutter test`. Expected: PASS.
- [ ] **Step 5: Commit** `gh-88: the phone as a tab of a window, with the feed of the desktop`.

### Task 9: Chat rendering: Markdown, code, KaTeX, Mermaid

**Files:**
- Create: `mobile/app/lib/chat/chat_screen.dart`, `mobile/app/lib/chat/markdown.dart`, `mobile/app/lib/chat/code.dart`, `mobile/app/lib/chat/mermaid.dart`
- Test: `mobile/app/test/markdown_test.dart`, `mobile/app/test/mermaid_test.dart`, `mobile/app/test/chat_screen_test.dart`

**Interfaces:**
- Consumes: Task 8 `WindowTab`, `FeedItem`; Task 4 `NbColors`.
- Produces: `Widget NbMarkdown(String text)` (`flutter_markdown_plus` with: fenced code → `CodeBlock(code, lang)` highlighted by `highlight` into `TextSpan`s with the `syn*` tokens, horizontally scrollable, a copy button; `$…$` and `$$…$$` → `flutter_math_fork` `Math.tex`, a parse error shows the source in `destructive`; ` ```mermaid ` → `MermaidBlock`); `MermaidBlock(String source)` renders with `mermaid_flutter`, and on a parse or layout failure shows the source as a code block with a one-line note; `ChatScreen(WindowTab)`: an app bar (folder, title, model pill, a state line), the feed list (user bubbles, assistant Markdown, tool lines collapsed to name + arg with the result on tap, done lines, markers), "Earlier" via `GET /history` as the web does, auto-scroll only while at the bottom.

- [ ] **Step 1: Write the failing tests:** `markdown_test.dart`: `a fenced ts block is highlighted` (a keyword span has `synKeyword`); `inline and display math render` (finds `Math` widgets); `bad TeX shows the source`. `mermaid_test.dart`: `the project's own diagrams render` — every ` ```mermaid ` block in `docs/architecture.md`, `docs/superpowers/specs/*.md` and `docs/superpowers/plans/*.md` renders without the fallback note; `a broken diagram falls back to its source`. `chat_screen_test.dart`: `the feed shows user, assistant, tool and done items`; `a streaming reply grows in place`.
- [ ] **Step 2: Run** `flutter test test/markdown_test.dart test/mermaid_test.dart test/chat_screen_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** If `mermaid_flutter` cannot draw one of the project's diagrams, record which in the ledger and keep that diagram in a `knownFallbacks` list in the test with the reason; the spec's WebView fallback is then a follow-up issue (see Rulings to confirm).
- [ ] **Step 4: Run** `flutter analyze --fatal-infos && flutter test`. Expected: PASS.
- [ ] **Step 5: Commit** `gh-88: chat feed with Markdown, highlighted code, KaTeX and Mermaid`.

### Task 10: Composer, approvals, questions and controls

**Files:**
- Create: `mobile/app/lib/chat/composer.dart`, `mobile/app/lib/chat/permission_sheet.dart`, `mobile/app/lib/chat/controls.dart`, `mobile/app/lib/chat/one_tab.dart`
- Test: `mobile/app/test/composer_test.dart`, `mobile/app/test/permission_test.dart`, `mobile/app/test/controls_test.dart`

**Interfaces:**
- Consumes: Task 8 `WindowTab.send`, `takeOver`, `models`, `caps`, `state`; `nb_protocol` `ClientMessageSend`, `…Interrupt`, `…Command`, `…Model`, `…Restart`, `…Permission`.
- Produces: `Composer(WindowTab)`: multi-line field, Send (`{type:'send', id:<uuid v4>, text}`; while busy asks "Send now and interrupt?" and sends `force: true`), Stop while busy (`{type:'interrupt'}`), `send-refused` → a snackbar with the reason, the text kept; disabled with a reason line when the tab is not `open` (offline: "Host offline · seen …"). `PermissionSheet`: a plain `permission` (no `prompt`) opens a modal bottom sheet over the chat with the tool name, the full `command ?? file_path ?? JSON` in monospace (scrollable, selectable), Allow / Deny → `{type:'permission', id, allow}`; a `permission` with `prompt` (Codex/OMP questions and structured approvals) is answered in the feed as a card with its fields and choices, sending `response:{choice, values?}` with the web's rules (required fields gate every choice but `deny`, `decline`, `cancel`; choice labels mapped as `PermissionCard.tsx:12`); `permission-done` closes the sheet or settles the card. `Controls` (app bar menu): Compact (`{type:'command', name:'compact'}`, disabled while busy or when `caps.compact` is false), Model and effort (a bottom sheet from `models` and `ModelOption.efforts`, sends `{type:'model', model, effort?, id}`; shown only when `protocol >= 6 && capabilities.models && models.isNotEmpty`), Restart agent (`{type:'restart'}`, with a confirm). `OneTabOverlay`: `occupied` → "Open in another tab" + "Work here"; `taken` → "Taken over by another tab" + "Work here".

- [ ] **Step 1: Write the failing tests:** `send writes a send message and clears the field`; `send while busy asks and sends force`; `send-refused keeps the text`; `offline disables sending and shows the last-seen time`; `a permission opens the sheet with the full command`; `Allow sends allow true`; `permission-done closes the sheet`; `a structured prompt needs its required field except for decline`; `compact is disabled while busy`; `the model sheet sends model and effort`; `restart asks first`; `Work here calls takeOver`.
- [ ] **Step 2: Run** `flutter test test/composer_test.dart test/permission_test.dart test/controls_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement**, every string in all six ARB files.
- [ ] **Step 4: Run** `flutter analyze --fatal-infos && flutter test`. Expected: PASS.
- [ ] **Step 5: Commit** `gh-88: composer, approvals, questions and the agent controls on the phone`.

### Task 11: Settings, docs and the full run

**Files:**
- Create: `mobile/app/lib/settings_screen.dart` (paired hosts with Forget — local only, with a note that the host side is `nota-bene remote revoke`; the phone's fingerprint; "Pair a host")
- Test: `mobile/app/test/settings_test.dart`
- Modify: `docs/guide.md` ("Remote access (prototype)": installing the APK from the CI artifact, pairing, what the app does and does not do yet), `server/src/remote/CHANNEL.md` (the Dart implementation in `mobile/channel` passes the same vectors and examples), `docs/architecture.md` §2.3 (the app's two packages), `mobile/README.md` (build and test commands)

- [ ] **Step 1: Write the failing test:** `forget asks, removes the host and stops its link`.
- [ ] **Step 2: Run** `flutter test test/settings_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement** and write the docs.
- [ ] **Step 4: Run** in order, each to exit 0: `npx tsc -b`; `npm test`; `(cd mobile/channel && dart test)`; `(cd mobile/app && flutter analyze --fatal-infos && flutter test)`. Expected: all pass.
- [ ] **Step 5: Commit** `gh-88: settings and docs for the phone app`. **PR B:** `gh-88: the chat on the phone` into `remote`.

## Rulings to confirm (made in this plan)

- No state-management library: `ChangeNotifier` + `ListenableBuilder`. Cost if wrong: a later move to Riverpod touches every screen.
- App language follows the phone's locale, not the host's `hello.lang` (several hosts may disagree). Cost: one setting later.
- Mermaid fallback: the source as a code block, not a WebView, unless Task 9 shows the project's diagrams need one; the WebView with a bundled mermaid.js becomes a follow-up issue. This narrows a spec line, so it is the author's call.
- The lock re-arms after 5 minutes in the background; links pause after 10. Cost: a constant.
- The APK is a debug build from CI. Each CI run signs with a fresh debug key, so installing a newer APK over an older one fails and needs an uninstall, which drops the phone key and the pairings. A stable signing key needs either the Android SDK on the dev machine or a keystore the author creates and stores as a repository secret (`ANDROID_KEYSTORE_B64` and its password); the agent does not handle that secret.
