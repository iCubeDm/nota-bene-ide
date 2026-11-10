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

  HostLink link({void Function(String)? onName}) => HostLink(
    paired(b64u(List.filled(32, 1))),
    f.factory,
    id,
    onName: onName,
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

  test('a connection that names the computer reports the name', () async {
    f.results.add(FakeChannel(null, 'studio-mac'));
    final names = <String>[];
    final l = link(onName: names.add)..start();
    await settle();
    expect(names, ['studio-mac']);
    l.stop();
  });

  group('refresh', () {
    test(
      'an online host is asked for its windows again, no reconnect',
      () async {
        final ch = FakeChannel([window(4791, '/p')]);
        f.results.add(ch);
        final l = link()..start();
        await settle();
        await l.refresh();
        expect(ch.refreshes, 1);
        expect(f.calls, hasLength(1));
        expect(l.state, LinkState.online);
        l.stop();
      },
    );

    test('it waits for the answer of an online host', () async {
      final ch = FakeChannel([window(4791, '/p')])..refreshGate = Completer();
      f.results.add(ch);
      final l = link()..start();
      await settle();
      var done = false;
      unawaited(l.refresh().then((_) => done = true));
      await settle();
      expect(done, isFalse);
      ch.refreshGate!.complete();
      await settle();
      expect(done, isTrue);
      l.stop();
    });

    test('a host that does not answer is given up on at the timeout', () async {
      final ch = FakeChannel([window(4791, '/p')])..refreshFails = true;
      f.results.add(ch);
      final l = link()..start();
      await settle();
      await l.refresh(); // completes, does not throw
      expect(l.state, LinkState.online);
      l.stop();
    });

    test('an offline host reconnects at once, skipping the backoff', () async {
      f.results.add(ChannelError('no answer'));
      final l = link()..start();
      await settle();
      expect(l.state, LinkState.offline);
      expect(sleeps, hasLength(1));
      f.results.add(FakeChannel([window(4791, '/p')]));
      await l.refresh();
      expect(l.state, LinkState.online);
      expect(f.calls, hasLength(2));
      expect(l.windows.single.port, 4791);
      l.stop();
    });

    test(
      'a refresh during the backoff wakes that one loop: one connect, ends online',
      () async {
        f.results.add(ChannelError('no answer'));
        final l = link()..start();
        await settle();
        expect(l.state, LinkState.offline);
        final gate = Completer<Channel>();
        f.results.add(gate.future); // the connect stays in flight
        var done = false;
        unawaited(l.refresh().then((_) => done = true));
        await settle();
        expect(l.state, LinkState.connecting);
        expect(f.calls, hasLength(2));
        // a second pull while the connect is in flight starts nothing
        unawaited(l.refresh());
        await settle();
        expect(
          f.calls,
          hasLength(2),
          reason: 'never two connects with one key',
        );
        expect(done, isFalse);
        gate.complete(FakeChannel([window(4791, '/p')]));
        await settle();
        expect(done, isTrue);
        expect(l.state, LinkState.online);
        expect(f.calls, hasLength(2));
        l.stop();
      },
    );

    test(
      'a refresh while a retry connect is in flight starts no second connect',
      () async {
        f.results.add(ChannelError('no answer'));
        final l = link()..start();
        await settle();
        final gate = Completer<Channel>();
        f.results.add(gate.future);
        await retry(); // the backoff ended on its own; the connect is under way
        var done = false;
        unawaited(l.refresh().then((_) => done = true));
        await settle();
        expect(
          f.calls,
          hasLength(2),
          reason: 'never two connects with one key',
        );
        gate.complete(FakeChannel([window(4791, '/p')]));
        await settle();
        expect(done, isTrue);
        expect(l.state, LinkState.online);
        expect(f.calls, hasLength(2));
        l.stop();
      },
    );

    test('a retry after the backoff shows connecting, not offline', () async {
      f.results.add(ChannelError('no answer'));
      final l = link()..start();
      await settle();
      expect(l.state, LinkState.offline);
      f.results.add(Completer<Channel>().future);
      await retry(); // the backoff ends, the next connect is under way
      expect(l.state, LinkState.connecting);
      l.stop();
    });

    test(
      'an offline host that is still down stays offline and the refresh ends',
      () async {
        f.results.add(ChannelError('no answer'));
        f.results.add(ChannelError('no answer'));
        final l = link()..start();
        await settle();
        await l.refresh();
        expect(l.state, LinkState.offline);
        expect(f.calls, hasLength(2));
        l.stop();
      },
    );

    test('a stopped link starts again', () async {
      f.results.add(FakeChannel([window(4791, '/p')]));
      final l = link()..start();
      await settle();
      l.stop();
      f.results.add(FakeChannel([window(4792, '/q')]));
      await l.refresh();
      expect(l.state, LinkState.online);
      expect(l.windows.single.port, 4792);
      l.stop();
    });

    test('an unpaired link is left alone', () async {
      f.results.add(ChannelError('closed', relayCode: 4403));
      final l = link()..start();
      await settle();
      await l.refresh();
      expect(f.calls, hasLength(1));
    });
  });

  group('refresh timeout', () {
    testWidgets('a host that never answers ends the refresh at 20 s (online)', (
      t,
    ) async {
      final ch = FakeChannel([window(4791, '/p')])
        ..refreshGate = Completer(); // never completes
      f.results.add(ch);
      final l = link()..start();
      await t.pump();
      expect(l.state, LinkState.online);
      var done = false;
      unawaited(l.refresh().then((_) => done = true));
      await t.pump(const Duration(seconds: 19));
      expect(done, isFalse);
      await t.pump(const Duration(seconds: 2));
      expect(done, isTrue);
      l.stop();
    });

    testWidgets('a link that stays connecting ends the refresh at 20 s', (
      t,
    ) async {
      f.results.add(Completer<Channel>().future);
      final l = link()..start();
      await t.pump();
      expect(l.state, LinkState.connecting);
      var done = false;
      unawaited(l.refresh().then((_) => done = true));
      await t.pump(const Duration(seconds: 19));
      expect(done, isFalse);
      await t.pump(const Duration(seconds: 2));
      expect(done, isTrue);
      l.stop();
    });
  });
}
