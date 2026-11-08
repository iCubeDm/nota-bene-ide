// The phone's channel against the real Go relay and the real Node connector (server/src/remote/crossHost.ts).
@Tags(['cross'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';
import 'package:test/test.dart';

class Host {
  Host._(this._p, this._lines);
  final Process _p;
  final StreamIterator<String> _lines;

  static Future<Host> start(String home) async {
    final p = await Process.start(
      'node',
      ['server/src/remote/crossHost.ts'],
      workingDirectory: '../..',
      environment: {'NOTA_BENE_HOME': home},
    );
    p.stderr.transform(utf8.decoder).listen(stderr.write);
    return Host._(
      p,
      StreamIterator(
        p.stdout.transform(utf8.decoder).transform(const LineSplitter()),
      ),
    );
  }

  Future<Map<String, Object?>> next([String? t]) async {
    for (;;) {
      if (!await _lines.moveNext().timeout(const Duration(seconds: 60))) {
        throw StateError('crossHost exited');
      }
      final m = jsonDecode(_lines.current) as Map<String, Object?>;
      if (m['t'] == 'error') throw StateError('crossHost: ${m['message']}');
      if (t == null || m['t'] == t) return m;
    }
  }

  void send(Map<String, Object?> m) => _p.stdin.writeln(jsonEncode(m));

  Future<void> stop() async {
    send({'op': 'stop'});
    await _p.exitCode.timeout(
      const Duration(seconds: 20),
      onTimeout: () {
        _p.kill();
        return -1;
      },
    );
  }
}

String uuid() {
  final r = Random.secure();
  return List.generate(
    16,
    (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

void main() {
  late Directory home;
  late Host host;
  late int port;
  late KeyPair key;
  late Uri relay;
  late Uint8List hostPub;
  String? deviceId;

  setUpAll(() async {
    home = await Directory.systemTemp.createTemp('nb-cross-home-');
    host = await Host.start(home.path);
    port = (await host.next('ready'))['port'] as int;
    key = await generateKeyPair();
  });

  tearDownAll(() async {
    await host.stop();
    await home.delete(recursive: true);
  });

  test('pairs with a QR code and lists the window', () async {
    host.send({'op': 'pair'});
    final p = parsePairUri((await host.next('code'))['uri'] as String);
    relay = p.relay;
    hostPub = p.hostPub;
    final ch = await Channel.connect(
      relay: relay,
      hostPub: hostPub,
      key: key,
      ticket: await pairTicket(p.secret),
      hello: {
        'v': 1,
        'name': 'Test phone',
        'pair': b64u(await pairProof(p.secret, key.pub)),
      },
    );
    deviceId = (await host.next('paired'))['id'] as String;
    final list = await ch.windows.firstWhere((l) => l.isNotEmpty);
    expect(list.single.port, port);
    expect(list.single.provider, 'claude');
    await ch.close();
  });

  test('reconnects with the saved pairing and talks HTTP', () async {
    final ch = await Channel.connect(relay: relay, hostPub: hostPub, key: key);
    final info = await ch.http(port, 'GET', '/info');
    expect(info.status, 200);
    expect(jsonDecode(utf8.decode(info.body)), contains('root'));
    final part = await ch.http(
      port,
      'GET',
      '/file?path=notes.md',
      headers: {'range': 'bytes=9-28'},
    );
    expect(part.status, 206);
    expect(utf8.decode(part.body), 'remote-cross-content');
    final big = await ch.http(port, 'GET', '/file?path=big.bin');
    expect(big.status, 200);
    expect(big.body.length, 700 * 1024);
    expect(
      [for (var i = 0; i < big.body.length; i += 4099) big.body[i]],
      [for (var i = 0; i < big.body.length; i += 4099) i % 251],
    );
    await ch.close();
  });

  test('a ws tab gets replay and hello', () async {
    final ch = await Channel.connect(relay: relay, hostPub: hostPub, key: key);
    final s = ch.ws(port, '/ws?tab=${uuid()}');
    final events = s.messages
        .where((m) => !m.binary)
        .map((m) => ServerEvent.fromJson(jsonDecode(utf8.decode(m.data))));
    final seen = await events
        .take(12)
        .takeWhile((e) => e is! ServerEventHello)
        .toList();
    expect(seen.first, isA<ServerEventReplay>());
    await ch.close();
  });

  test('a relay restart closes the channel and a new one works', () async {
    final ch = await Channel.connect(relay: relay, hostPub: hostPub, key: key);
    host.send({'op': 'restart-relay'});
    await host.next('restarted');
    await ch.closed.timeout(const Duration(seconds: 10));
    // the connector needs a moment to come back online
    Channel? again;
    for (var i = 0; again == null && i < 50; i++) {
      try {
        again = await Channel.connect(relay: relay, hostPub: hostPub, key: key);
      } on ChannelError {
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
    }
    expect(again, isNotNull);
    expect(await again!.windows.firstWhere((l) => l.isNotEmpty), hasLength(1));
    await again.close();
  });

  test('a revoked phone gets 4403', () async {
    final ch = await Channel.connect(relay: relay, hostPub: hostPub, key: key);
    host.send({'op': 'revoke', 'id': deviceId});
    await host.next('revoked');
    await ch.closed.timeout(const Duration(seconds: 10));
    await expectLater(
      Channel.connect(relay: relay, hostPub: hostPub, key: key),
      throwsA(
        isA<ChannelError>().having((e) => e.relayCode, 'relayCode', 4403),
      ),
    );
  });
}
