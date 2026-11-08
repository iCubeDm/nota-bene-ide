import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:nb_channel/nb_channel.dart';
import 'package:test/test.dart';

Uint8List hex(String s) => Uint8List.fromList([
  for (var i = 0; i < s.length; i += 2)
    int.parse(s.substring(i, i + 2), radix: 16),
]);
String toHex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Future<KeyPair> pair(String priv) async =>
    (priv: hex(priv), pub: await publicOf(hex(priv)));

void main() {
  test('reproduces every vector', () async {
    final file =
        jsonDecode(
              File(
                '../../server/src/remote/noise-vectors.json',
              ).readAsStringSync(),
            )
            as Map<String, Object?>;
    final vectors = (file['vectors'] as List).cast<Map<String, Object?>>();
    expect(vectors, isNotEmpty);
    for (final v in vectors) {
      expect(v['protocol_name'], 'Noise_IK_25519_ChaChaPoly_SHA256');
      final prologue = hex(v['init_prologue'] as String);
      final ini = await Handshake.initiator(
        s: await pair(v['init_static'] as String),
        rs: hex(v['init_remote_static'] as String),
        prologue: prologue,
        e: await pair(v['init_ephemeral'] as String),
      );
      final res = await Handshake.responder(
        s: await pair(v['resp_static'] as String),
        prologue: prologue,
        e: await pair(v['resp_ephemeral'] as String),
      );
      ({CipherState send, CipherState recv})? i, r;
      final messages = (v['messages'] as List).cast<Map<String, Object?>>();
      for (var n = 0; n < messages.length; n++) {
        final m = messages[n];
        final fromInit = n.isEven;
        final payload = hex(m['payload'] as String);
        Uint8List ct, pt;
        if (n < 2) {
          ct = await (fromInit ? ini : res).writeMessage(payload);
          pt = await (fromInit ? res : ini).readMessage(ct);
          if (n == 1) {
            i = ini.split();
            r = res.split();
            if (v['handshake_hash'] != null) {
              expect(toHex(ini.handshakeHash), v['handshake_hash']);
              expect(toHex(res.handshakeHash), v['handshake_hash']);
            }
          }
        } else {
          ct = await (fromInit ? i! : r!).send.encrypt(payload);
          pt = await (fromInit ? r! : i!).recv.decrypt(ct);
        }
        expect(toHex(ct), m['ciphertext'], reason: 'message $n');
        expect(toHex(pt), m['payload']);
      }
    }
  });

  Future<
    ({
      ({CipherState send, CipherState recv}) i,
      ({CipherState send, CipherState recv}) r,
      Handshake res,
      KeyPair is_,
    })
  >
  connected() async {
    final is_ = await generateKeyPair(), rs = await generateKeyPair();
    final ini = await Handshake.initiator(s: is_, rs: rs.pub);
    final res = await Handshake.responder(s: rs);
    await res.readMessage(await ini.writeMessage(utf8.encode('hi')));
    await ini.readMessage(await res.writeMessage());
    expect(ini.done && res.done, isTrue);
    return (i: ini.split(), r: res.split(), res: res, is_: is_);
  }

  test('the responder learns the initiator key', () async {
    final c = await connected();
    expect(c.res.remoteStatic, c.is_.pub);
  });

  test('a tampered message kills the state', () async {
    final c = await connected();
    final a = await c.i.send.encrypt(utf8.encode('one'));
    final b = await c.i.send.encrypt(utf8.encode('two'));
    a[0] ^= 1;
    await expectLater(c.r.recv.decrypt(a), throwsA(isA<NoiseError>()));
    await expectLater(c.r.recv.decrypt(b), throwsA(isA<NoiseError>()));
  });

  test('an all-zero DH is refused', () async {
    final k = await generateKeyPair();
    await expectLater(dh(k.priv, Uint8List(32)), throwsA(isA<NoiseError>()));
  });

  test('a message beyond the plaintext limit is refused', () async {
    final c = await connected();
    await expectLater(
      c.i.send.encrypt(Uint8List(maxPlaintext + 1)),
      throwsA(isA<NoiseError>()),
    );
  });
}
