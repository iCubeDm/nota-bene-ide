// Noise_IK_25519_ChaChaPoly_SHA256 (Noise spec revision 34, sections 4, 5 and 7.5): a port of
// server/src/remote/noise.ts on the `cryptography` package. The phone is the initiator and pins the host's static key
// from the pairing QR; the host is the responder. Checked against server/src/remote/noise-vectors.json.
import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

typedef KeyPair = ({Uint8List pub, Uint8List priv});

class NoiseError implements Exception {
  NoiseError(this.message);
  final String message;
  @override
  String toString() => 'NoiseError: $message';
}

const protocolName = 'Noise_IK_25519_ChaChaPoly_SHA256';
const prologue = 'nb-e2e-v1';
const maxMessage = 65535;
const maxPlaintext = maxMessage - 16;

final _x25519 = X25519();
final _aead = Chacha20.poly1305Aead();
final _sha256 = Sha256();
final _hmac = Hmac.sha256();

void _check32(List<int> b, String what) {
  if (b.length != 32) throw NoiseError('$what must be 32 bytes');
}

Future<KeyPair> generateKeyPair() async {
  final kp = await _x25519.newKeyPair();
  final priv = Uint8List.fromList(await kp.extractPrivateKeyBytes());
  return (priv: priv, pub: await publicOf(priv));
}

Future<Uint8List> publicOf(Uint8List priv) async {
  _check32(priv, 'a private key');
  final kp = await _x25519.newKeyPairFromSeed(priv);
  return Uint8List.fromList((await kp.extractPublicKey()).bytes);
}

/// X25519; a low-order peer key (an all-zero result) is refused.
Future<Uint8List> dh(Uint8List priv, Uint8List pub) async {
  _check32(priv, 'a private key');
  _check32(pub, 'a public key');
  final List<int> out;
  try {
    final key = await _x25519.sharedSecretKey(
      keyPair: await _x25519.newKeyPairFromSeed(priv),
      remotePublicKey: SimplePublicKey(pub, type: KeyPairType.x25519),
    );
    out = await key.extractBytes();
  } catch (_) {
    throw NoiseError('key agreement failed');
  }
  if (out.every((b) => b == 0)) throw NoiseError('key agreement failed');
  return Uint8List.fromList(out);
}

Uint8List _cat(List<List<int>> parts) {
  final b = BytesBuilder(copy: false);
  for (final p in parts) {
    b.add(p);
  }
  return b.toBytes();
}

Future<Uint8List> _hash(List<List<int>> parts) async =>
    Uint8List.fromList((await _sha256.hash(_cat(parts))).bytes);

Future<Uint8List> _mac(List<int> key, List<List<int>> parts) async =>
    Uint8List.fromList(
      (await _hmac.calculateMac(_cat(parts), secretKey: SecretKey(key))).bytes,
    );

Future<(Uint8List, Uint8List)> _hkdf(Uint8List ck, List<int> ikm) async {
  final temp = await _mac(ck, [ikm]);
  final o1 = await _mac(temp, [
    [1],
  ]);
  final o2 = await _mac(temp, [
    o1,
    [2],
  ]);
  return (o1, o2);
}

// 2^64 - 1 is reserved by the spec; Dart ints are 64-bit signed, so the counter stops well before it.
const _maxNonce = 0x7fffffffffffffff;

class CipherState {
  CipherState([this._k]);
  final Uint8List? _k;
  int _n = 0;
  bool _dead = false;

  bool get hasKey => _k != null;

  Uint8List _nonce() {
    if (_dead) throw NoiseError('the channel failed earlier');
    if (_n >= _maxNonce) throw NoiseError('nonce exhausted');
    final iv = ByteData(12)..setUint64(4, _n, Endian.little);
    return iv.buffer.asUint8List();
  }

  Future<Uint8List> encrypt(List<int> plain, {List<int> ad = const []}) async {
    if (plain.length > maxPlaintext) throw NoiseError('message too large');
    final k = _k;
    if (k == null) return Uint8List.fromList(plain);
    final box = await _aead.encrypt(
      plain,
      secretKey: SecretKey(k),
      nonce: _nonce(),
      aad: ad,
    );
    _n++;
    return _cat([box.cipherText, box.mac.bytes]);
  }

  /// A failed decrypt leaves the state unusable: the channel is torn down, never resynchronised.
  Future<Uint8List> decrypt(List<int> cipher, {List<int> ad = const []}) async {
    final k = _k;
    if (k == null) return Uint8List.fromList(cipher);
    final iv = _nonce();
    try {
      if (cipher.length < 16 || cipher.length > maxMessage) {
        throw NoiseError('length');
      }
      final cut = cipher.length - 16;
      final out = await _aead.decrypt(
        SecretBox(
          cipher.sublist(0, cut),
          nonce: iv,
          mac: Mac(cipher.sublist(cut)),
        ),
        secretKey: SecretKey(k),
        aad: ad,
      );
      _n++;
      return Uint8List.fromList(out);
    } catch (_) {
      _dead = true;
      throw NoiseError('decryption failed');
    }
  }
}

class _Symmetric {
  _Symmetric(this.h) : ck = h;
  Uint8List ck;
  Uint8List h;
  CipherState cs = CipherState();

  static Future<_Symmetric> start() async {
    final name = ascii.encode(protocolName);
    return _Symmetric(
      name.length <= 32
          ? _cat([name, Uint8List(32 - name.length)])
          : await _hash([name]),
    );
  }

  Future<void> mixKey(List<int> ikm) async {
    final (ck, k) = await _hkdf(this.ck, ikm);
    this.ck = ck;
    cs = CipherState(k);
  }

  Future<void> mixHash(List<int> data) async => h = await _hash([h, data]);

  Future<Uint8List> encryptAndHash(List<int> plain) async {
    final c = await cs.encrypt(plain, ad: h);
    await mixHash(c);
    return c;
  }

  Future<Uint8List> decryptAndHash(List<int> cipher) async {
    final p = await cs.decrypt(cipher, ad: h);
    await mixHash(cipher);
    return p;
  }
}

enum _Step { write1, read1, write2, read2, done, failed }

/// One IK handshake: `<- s ... -> e, es, s, ss` then `<- e, ee, se`.
class Handshake {
  Handshake._(this._ss, this._s, this._e, this._rs, this._initiator)
    : _step = _initiator ? _Step.write1 : _Step.read1;

  final _Symmetric _ss;
  final KeyPair _s;
  KeyPair? _e;
  Uint8List? _rs;
  Uint8List? _re;
  final bool _initiator;
  _Step _step;
  // HKDF(ck, empty), taken when the last handshake message goes through so that split() stays synchronous
  (Uint8List, Uint8List)? _splitKeys;

  static Future<Handshake> _make(
    KeyPair s,
    Uint8List? rs,
    List<int>? prologueBytes,
    KeyPair? e,
    bool initiator,
  ) async {
    final ss = await _Symmetric.start();
    await ss.mixHash(prologueBytes ?? ascii.encode(prologue));
    // pre-message: the responder's static key, known to both
    await ss.mixHash(initiator ? rs! : s.pub);
    return Handshake._(ss, s, e, rs, initiator);
  }

  static Future<Handshake> initiator({
    required KeyPair s,
    required Uint8List rs,
    List<int>? prologue,
    KeyPair? e,
  }) {
    _check32(rs, 'the remote static key');
    return _make(s, rs, prologue, e, true);
  }

  static Future<Handshake> responder({
    required KeyPair s,
    List<int>? prologue,
    KeyPair? e,
  }) => _make(s, null, prologue, e, false);

  bool get done => _step == _Step.done;

  /// The responder learns it only from a message 1 that decrypted.
  Uint8List? get remoteStatic => _rs;

  Uint8List get handshakeHash => _ss.h;

  void _expect(_Step step) {
    if (_step != step) {
      throw NoiseError('handshake out of order (at ${_step.name})');
    }
  }

  Future<T> _guard<T>(_Step next, Future<T> Function() f) async {
    try {
      final out = await f();
      _step = next;
      return out;
    } catch (e) {
      _step = _Step.failed;
      if (e is NoiseError) rethrow;
      throw NoiseError('$e');
    }
  }

  Uint8List _sized(Uint8List m) {
    if (m.length > maxMessage) throw NoiseError('message too large');
    return m;
  }

  Future<Uint8List> writeMessage([List<int> payload = const []]) {
    final ss = _ss;
    if (_initiator) {
      _expect(_Step.write1);
      return _guard(_Step.read2, () async {
        final e = _e ??= await generateKeyPair();
        await ss.mixHash(e.pub);
        await ss.mixKey(await dh(e.priv, _rs!)); // es
        final s = await ss.encryptAndHash(_s.pub);
        await ss.mixKey(await dh(_s.priv, _rs!)); // ss
        return _sized(_cat([e.pub, s, await ss.encryptAndHash(payload)]));
      });
    }
    _expect(_Step.write2);
    return _guard(_Step.done, () async {
      final e = _e ??= await generateKeyPair();
      await ss.mixHash(e.pub);
      await ss.mixKey(await dh(e.priv, _re!)); // ee
      await ss.mixKey(await dh(e.priv, _rs!)); // se
      final out = _sized(_cat([e.pub, await ss.encryptAndHash(payload)]));
      _splitKeys = await _hkdf(ss.ck, const []);
      return out;
    });
  }

  Future<Uint8List> readMessage(List<int> msg) {
    if (msg.length > maxMessage) throw NoiseError('message too large');
    final ss = _ss;
    if (!_initiator) {
      _expect(_Step.read1);
      return _guard(_Step.write2, () async {
        if (msg.length < 32 + 48 + 16) throw NoiseError('message too short');
        final re = _re = Uint8List.fromList(msg.sublist(0, 32));
        await ss.mixHash(re);
        await ss.mixKey(await dh(_s.priv, re)); // es
        final rs = await ss.decryptAndHash(msg.sublist(32, 80));
        await ss.mixKey(await dh(_s.priv, rs)); // ss
        final payload = await ss.decryptAndHash(msg.sublist(80));
        _rs = rs;
        return payload;
      });
    }
    _expect(_Step.read2);
    return _guard(_Step.done, () async {
      if (msg.length < 32 + 16) throw NoiseError('message too short');
      final re = _re = Uint8List.fromList(msg.sublist(0, 32));
      await ss.mixHash(re);
      await ss.mixKey(await dh(_e!.priv, re)); // ee
      await ss.mixKey(await dh(_s.priv, re)); // se
      final payload = await ss.decryptAndHash(msg.sublist(32));
      _splitKeys = await _hkdf(ss.ck, const []);
      return payload;
    });
  }

  /// The transport keys, once both messages are through: the initiator sends with the first.
  ({CipherState send, CipherState recv}) split() {
    _expect(_Step.done);
    final ks = _splitKeys!;
    final c1 = CipherState(ks.$1), c2 = CipherState(ks.$2);
    return _initiator ? (send: c1, recv: c2) : (send: c2, recv: c1);
  }
}
