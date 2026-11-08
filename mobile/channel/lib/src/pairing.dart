// The pairing values of server/src/remote/CHANNEL.md and the device's admission proof of relay/PROTOCOL.md: ports of
// the matching functions in server/src/remote/store.ts and relayClient.ts.
import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'noise.dart';

String b64u(List<int> b) => base64Url.encode(b).replaceAll('=', '');

Uint8List fromB64u(String s, [int? length]) {
  if (!RegExp(r'^[A-Za-z0-9_-]*$').hasMatch(s)) {
    throw const FormatException('not base64url');
  }
  final Uint8List b;
  try {
    b = base64Url.decode(base64Url.normalize(s));
  } on FormatException {
    throw const FormatException('not base64url');
  }
  if ((length != null && b.length != length) || b64u(b) != s) {
    throw FormatException('not ${length ?? b.length} bytes of base64url');
  }
  return b;
}

final _sha256 = Sha256();
final _hmac = Hmac.sha256();

Future<Uint8List> _sha(List<int> b) async =>
    Uint8List.fromList((await _sha256.hash(b)).bytes);

Future<Uint8List> _mac(
  List<int> key,
  String label, [
  List<int> more = const [],
]) async => Uint8List.fromList(
  (await _hmac.calculateMac([
    ...ascii.encode(label),
    ...more,
  ], secretKey: SecretKey(key))).bytes,
);

/// What the relay knows a device by: base64url(SHA-256(public key)).
Future<String> deviceHash(Uint8List pub) async => b64u(await _sha(pub));

const _b32 = 'abcdefghijklmnopqrstuvwxyz234567';

/// What a person compares: the first 10 bytes of SHA-256(key), base32, `abcd-efgh-ijkl-mnop`.
Future<String> fingerprint(Uint8List pub) async {
  final bytes = (await _sha(pub)).sublist(0, 10);
  var bits = 0, acc = 0;
  final out = StringBuffer();
  for (final b in bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out.write(_b32[(acc >> (bits - 5)) & 31]);
      bits -= 5;
    }
  }
  final s = out.toString();
  return [
    for (var i = 0; i < s.length; i += 4) s.substring(i, i + 4),
  ].join('-');
}

/// What the phone presents to the relay while pairing; the relay never learns the secret.
Future<Uint8List> pairTicket(Uint8List secret) =>
    _mac(secret, 'nb-relay-ticket-v1');

/// What the phone puts in handshake message 1 to prove it scanned the QR, bound to its own key.
Future<Uint8List> pairProof(Uint8List secret, Uint8List devicePub) =>
    _mac(secret, 'nb-pair-v1', devicePub);

/// The relay's admission proof: HMAC-SHA256(key = X25519(priv, eph), "nb-relay-v1 device" ‖ nonce).
Future<Uint8List> relayProof(
  Uint8List priv,
  Uint8List eph,
  Uint8List nonce,
) async => _mac(await dh(priv, eph), 'nb-relay-v1 device', nonce);

void _checkRelay(Uri u) {
  final local = const ['127.0.0.1', 'localhost', '::1'].contains(u.host);
  if (u.scheme == 'wss' && u.host.isNotEmpty) return;
  if (u.scheme == 'ws' && local && u.hasPort) return;
  throw const FormatException('the relay must be a wss:// address');
}

/// The QR of `nota-bene remote pair`. Throws [FormatException] for anything else.
({Uri relay, Uint8List hostPub, Uint8List secret}) parsePairUri(String s) {
  const head = 'nbremote://pair?';
  if (!s.startsWith(head)) throw const FormatException('not a pairing code');
  final Map<String, String> q;
  try {
    q = Uri.splitQueryString(s.substring(head.length));
  } on Object {
    throw const FormatException('not a pairing code');
  }
  if (q['v'] != '1') {
    throw const FormatException('unsupported pairing code version');
  }
  final relay = Uri.tryParse(q['r'] ?? '');
  if (relay == null) {
    throw const FormatException('the relay must be a wss:// address');
  }
  _checkRelay(relay);
  return (
    relay: relay,
    hostPub: fromB64u(q['h'] ?? '', 32),
    secret: fromB64u(q['s'] ?? '', 32),
  );
}
