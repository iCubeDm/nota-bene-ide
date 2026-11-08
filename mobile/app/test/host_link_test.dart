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

  test('stop goes offline and a new start runs one loop', () async {
    final ch = FakeChannel([window(4791, '/p')]);
    f.results.add(ch);
    final l = link()..start();
    await settle();
    expect(l.state, LinkState.online);
    l.stop();
    await settle();
    expect(l.state, LinkState.offline);
    expect(l.channel, isNull);
    f.results.add(FakeChannel([window(4791, '/p')]));
    l.start();
    expect(l.state, LinkState.connecting);
    l.start(); // twice: still one loop
    await settle();
    expect(l.state, LinkState.online);
    expect(f.calls, hasLength(2));
    l.stop();
  });

  test(
    '4409 (this key connected elsewhere) stops instead of fighting for the slot',
    () async {
      final ch = FakeChannel([window(4791, '/p')]);
      f.results.add(ch);
      final l = link()..start();
      await settle();
      ch.drop(4409);
      await settle();
      expect(l.state, LinkState.offline);
      expect(
        sleeps,
        isEmpty,
        reason: 'no automatic reconnect (relay/PROTOCOL.md)',
      );
      expect(f.calls, hasLength(1));
      l.start();
      await settle();
      expect(f.calls, hasLength(2));
      l.stop();
    },
  );

  test('a host paired again gets a fresh link', () async {
    final v = MemoryVault();
    final hosts = await Hosts.load(v);
    final h = paired(b64u(List.filled(32, 1)));
    await hosts.add(h);
    f.results.add(ChannelError('closed', relayCode: 4403));
    final links = Links(
      hosts,
      f.factory,
      id,
      sleep: (_) => Completer<void>().future,
    );
    await settle();
    expect(links.of(h.id)!.state, LinkState.unpaired);
    f.results.add(FakeChannel([window(4791, '/p')]));
    await hosts.add(
      PairedHost(
        id: h.id,
        relay: Uri.parse('wss://other.example.com'),
        label: 'again',
        pairedAt: DateTime(2027),
      ),
    );
    await settle();
    final l = links.of(h.id)!;
    expect(l.state, LinkState.online);
    expect(l.host.relay, Uri.parse('wss://other.example.com'));
    links.dispose();
  });

  test('pausing one host stops only its link', () async {
    final v = MemoryVault();
    final hosts = await Hosts.load(v);
    final a = paired(b64u(List.filled(32, 1))),
        b = paired(b64u(List.filled(32, 2)));
    await hosts.add(a);
    await hosts.add(b);
    f.results.addAll([
      FakeChannel([window(1, '/a')]),
      FakeChannel([window(2, '/b')]),
    ]);
    final links = Links(
      hosts,
      f.factory,
      id,
      sleep: (_) => Completer<void>().future,
    );
    await settle();
    links.pauseHost(a.id);
    await settle();
    expect(links.of(a.id)!.state, LinkState.offline);
    expect(links.of(b.id)!.state, LinkState.online);
    f.results.add(FakeChannel([window(1, '/a')]));
    links.resumeHost(a.id);
    await settle();
    expect(links.of(a.id)!.state, LinkState.online);
    links.dispose();
  });
}
