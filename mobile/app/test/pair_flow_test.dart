import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/pairing/confirm_screen.dart';
import 'package:nb_app/pairing/pair_flow.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

Uint8List seq(int from) =>
    Uint8List.fromList(List.generate(32, (i) => from + i));

String qr({String relay = 'wss://relay.example.com'}) =>
    'nbremote://pair?v=1&r=${Uri.encodeComponent(relay)}&h=${b64u(seq(0x21))}&s=${b64u(seq(0x41))}';

void main() {
  late Identity id;
  late Hosts hosts;
  late FakeFactory f;
  late PairFlow flow;

  setUp(() async {
    final v = MemoryVault();
    id = await Identity.load(v);
    hosts = await Hosts.load(v);
    f = FakeFactory();
    flow = PairFlow(f.factory, id, hosts);
  });

  test('a valid code pairs and saves the host', () async {
    f.results.add(FakeChannel([window(4791, '/home/u/projects/notes')]));
    final r = await flow.pair(qr(), deviceName: 'Pixel 9');
    expect(r, isA<Paired>());
    final call = f.calls.single;
    expect(call.relay, Uri.parse('wss://relay.example.com'));
    expect(call.hostPub, seq(0x21));
    expect(call.ticket, await pairTicket(seq(0x41)));
    expect(call.hello, {
      'v': 1,
      'name': 'Pixel 9',
      'pair': b64u(await pairProof(seq(0x41), id.key.pub)),
    });
    final h = hosts.all.single;
    expect((h.id, h.label), (b64u(seq(0x21)), 'notes'));
    final p = r as Paired;
    expect(p.hostFingerprint, await fingerprint(seq(0x21)));
    expect(p.phoneFingerprint, await id.fingerprint);
  });

  test(
    'the host\'s own link is paused while pairing and resumed after',
    () async {
      final events = <String>[];
      flow = PairFlow(
        f.factory,
        id,
        hosts,
        pause: (h) => events.add('pause $h'),
        resume: (h) => events.add('resume $h'),
      );
      f.results.add(ChannelError('closed', relayCode: 4403));
      await flow.pair(qr(), deviceName: 'x');
      expect(events, ['pause ${b64u(seq(0x21))}', 'resume ${b64u(seq(0x21))}']);
    },
  );

  test('a scanner seeing the same failed code again does not retry it', () {
    final g = ScanGate();
    expect(g.accept('nbremote://a'), isTrue);
    g.failed('nbremote://a');
    expect(g.accept('nbremote://a'), isFalse);
    expect(g.accept('nbremote://b'), isTrue);
    expect(g.accept('https://x'), isFalse);
  });

  test('a host that lists no window yet is named by its fingerprint', () async {
    final r = await flow.pair(
      qr(),
      deviceName: 'Pixel 9',
      windowsWait: Duration.zero,
    );
    expect(r, isA<Paired>());
    expect(
      hosts.all.single.label,
      (await fingerprint(seq(0x21))).substring(0, 9),
    );
  });

  test('a 4403 says the code expired or was used', () async {
    f.results.add(ChannelError('closed', relayCode: 4403));
    final r = await flow.pair(qr(), deviceName: 'x');
    expect((r as PairFailed).reason, PairError.codeUsed);
    expect(hosts.all, isEmpty);
  });

  test('an unreachable relay says so', () async {
    f.results.add(ChannelError('no answer'));
    expect(
      ((await flow.pair(qr(), deviceName: 'x')) as PairFailed).reason,
      PairError.unreachable,
    );
  });

  test('an http:// QR is not a Nota Bene code', () async {
    for (final bad in [
      'https://example.com',
      qr(relay: 'http://relay.example.com'),
      '',
    ]) {
      expect(
        ((await flow.pair(bad, deviceName: 'x')) as PairFailed).reason,
        PairError.notACode,
      );
    }
    expect(f.calls, isEmpty);
  });

  testWidgets('the confirm screen shows both fingerprints', (t) async {
    var done = false;
    await t.pumpWidget(
      NbApp(
        home: ConfirmScreen(
          result: Paired(
            PairedHost(
              id: 'x',
              relay: Uri.parse('wss://r.example'),
              label: 'notes',
              pairedAt: DateTime(2026),
            ),
            'abcd-efgh-ijkl-mnop',
            'qrst-uvwx-yz23-4567',
          ),
          onDone: () => done = true,
        ),
      ),
    );
    expect(find.text('abcd-efgh-ijkl-mnop'), findsOneWidget);
    expect(find.text('qrst-uvwx-yz23-4567'), findsOneWidget);
    expect(find.textContaining('notes'), findsWidgets);
    await t.tap(find.byType(FilledButton));
    expect(done, isTrue);
  });
}
