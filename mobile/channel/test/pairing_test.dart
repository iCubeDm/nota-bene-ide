import 'dart:typed_data';

import 'package:nb_channel/nb_channel.dart';
import 'package:test/test.dart';

Uint8List seq(int from) =>
    Uint8List.fromList(List.generate(32, (i) => from + i));

void main() {
  test('the CHANNEL.md worked example', () async {
    final secret = seq(0x41);
    expect(b64u(secret), 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2A');
    final pub = await publicOf(seq(0x01));
    expect(b64u(pub), 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw');
    expect(
      b64u(await pairTicket(secret)),
      'DDKWMnMYXab17ezikDLd7uircFsUBcu40ksUtkI0_Jg',
    );
    expect(
      b64u(await pairProof(secret, pub)),
      'YRz0Sr3BMUsRN5L4FiM1AYx_uBwdAmnmW9zZrBBXqxE',
    );
    expect(await fingerprint(pub), 'vkup-75yd-wufs-ff7u');
  });

  test('the relay/PROTOCOL.md example', () async {
    final pub = await publicOf(seq(0x01));
    expect(
      await deviceHash(pub),
      'qqj_9wO1CyKX9PbhNQj3JCDZb9Aeu4TLB0RJyq72QEE',
    );
    final eph = fromB64u('ZLEBsdC-WocEvQePmJUAH8A-jp-VIvGI3RKNmEbUhGY', 32);
    expect(
      b64u(await relayProof(seq(0x01), eph, seq(0x61))),
      'X2BJlpgFEN2Z9t7I2JL_d3lZgo0FRsi2nCTG5pOa6II',
    );
  });

  group('parsePairUri', () {
    final h = b64u(seq(0x21));
    final s = b64u(seq(0x41));
    String uri(String r, {String v = '1', String? secret}) =>
        'nbremote://pair?v=$v&r=${Uri.encodeComponent(r)}&h=$h&s=${secret ?? s}';

    test('accepts what the host shows', () {
      final p = parsePairUri(uri('wss://relay.example.com'));
      expect(p.relay.toString(), 'wss://relay.example.com');
      expect(p.hostPub, seq(0x21));
      expect(p.secret, seq(0x41));
      expect(parsePairUri(uri('ws://127.0.0.1:4791')).relay.port, 4791);
      expect(parsePairUri(uri('ws://localhost:4791')).relay.host, 'localhost');
    });

    test('refuses everything else', () {
      for (final bad in [
        uri('http://relay.example.com'),
        uri('ws://example.com'),
        uri('ws://127.0.0.1'),
        uri('wss://relay.example.com', v: '2'),
        uri('wss://relay.example.com', secret: b64u(seq(0x41).sublist(1))),
        'nbremote://pair?v=1&r=${Uri.encodeComponent('wss://r.example')}&h=$h',
        'https://example.com/?s=$s',
        'not a uri at all',
      ]) {
        expect(() => parsePairUri(bad), throwsFormatException, reason: bad);
      }
    });
  });

  test('fromB64u checks the length', () {
    expect(() => fromB64u(b64u(seq(1)), 31), throwsFormatException);
  });
}
