import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

PairedHost paired(String id) => PairedHost(
  id: id,
  relay: Uri.parse('wss://relay.example.com'),
  label: id,
  pairedAt: DateTime(2026),
);

Future<void> settle() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  late Identity id;
  late DateTime now;
  late FakeFactory f;
  late List<Duration> sleeps;
  late Completer<void> wake;

  setUp(() async {
    id = await Identity.load(MemoryVault());
    now = DateTime(2026, 11, 8, 12);
    f = FakeFactory();
    sleeps = [];
    wake = Completer<void>();
  });

  HostLink link() => HostLink(
    paired(b64u(List.filled(32, 1))),
    f.factory,
    id,
    clock: () => now,
    jitter: () => 0.5, // a factor of exactly 1
    sleep: (d) {
      sleeps.add(d);
      wake = Completer<void>();
      return wake.future;
    },
  );

  Future<void> retry() async {
    wake.complete();
    await settle();
  }

  test('backoff doubles to 30 s and resets after a minute online', () async {
    for (var i = 0; i < 7; i++) {
      f.results.add(ChannelError('no answer'));
    }
    final l = link()..start();
    await settle();
    for (var i = 0; i < 6; i++) {
      await retry();
    }
    expect(sleeps.map((d) => d.inSeconds), [1, 2, 4, 8, 16, 30, 30]);
    expect(l.state, LinkState.offline);

    final ch = FakeChannel([window(4791, '/p')]);
    f.results.add(ch);
    await retry();
    expect(l.state, LinkState.online);
    now = now.add(const Duration(seconds: 61));
    ch.drop();
    await settle();
    expect(l.state, LinkState.offline);
    expect(sleeps.last, const Duration(seconds: 1));
    l.stop();
  });

  test('4403 stops the link and marks it unpaired', () async {
    f.results.add(ChannelError('closed', relayCode: 4403));
    final l = link()..start();
    await settle();
    expect(l.state, LinkState.unpaired);
    expect(sleeps, isEmpty);
    expect(f.calls, hasLength(1));
  });

  test('a connect sends no ticket and no pairing proof', () async {
    final l = link()..start();
    await settle();
    expect(f.calls.single.ticket, isNull);
    expect(f.calls.single.hello, {'v': 1});
    l.stop();
  });

  test('offline keeps the last windows and the last-seen time', () async {
    final ch = FakeChannel([window(4791, '/p', title: 'Notes')]);
    f.results.add(ch);
    final l = link()..start();
    await settle();
    expect(l.windows.single.title, 'Notes');
    now = now.add(const Duration(minutes: 3));
    ch.drop();
    await settle();
    expect(l.state, LinkState.offline);
    expect(l.windows.single.port, 4791);
    expect(l.lastSeen, now);
    l.stop();
  });

  test('notifies on every change of state and windows', () async {
    final ch = FakeChannel();
    f.results.add(ch);
    final l = link();
    var n = 0;
    l.addListener(() => n++);
    l.start();
    await settle();
    final before = n;
    ch.push([window(4791, '/p')]);
    await settle();
    expect(n, before + 1);
    l.stop();
  });
}
