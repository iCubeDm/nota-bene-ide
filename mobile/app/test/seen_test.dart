import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

HostWindow win(String? session, int? replies) => HostWindow(
  port: 4791,
  provider: 'claude',
  root: '/home/u/notes',
  session: session,
  replies: replies,
);

void main() {
  late MemoryVault v;
  late Seen seen;

  setUp(() async {
    v = MemoryVault();
    seen = await Seen.load(v);
  });

  test('first sight is seen up to the current replies', () {
    seen.observe('h', [win('s1', 5)]);
    expect(seen.unread('h', win('s1', 5)), 0);
    expect(seen.unread('h', win('s1', 7)), 2);
  });

  test('unread is pure: it records nothing and does not notify', () async {
    var notified = 0;
    seen.addListener(() => notified++);
    expect(seen.unread('h', win('s1', 5)), 0);
    expect(seen.seenOf('h', 's1'), 0);
    expect(seen.unread('h', win('s1', 6)), 0);
    expect(notified, 0);
    expect(v.values['nb.seen'], isNull);
  });

  test('unread after replies grow, and see clears it', () async {
    seen.observe('h', [win('s1', 1)]);
    expect(seen.unread('h', win('s1', 4)), 3);
    await seen.see('h', 's1', 4);
    expect(seen.seenOf('h', 's1'), 4);
    expect(seen.unread('h', win('s1', 4)), 0);
  });

  test('persists across a new instance', () async {
    seen.observe('h', [win('s1', 1)]);
    await seen.see('h', 's1', 3);
    final again = await Seen.load(v);
    expect(again.seenOf('h', 's1'), 3);
    expect(again.unread('h', win('s1', 5)), 2);
  });

  test('a session id and a host have their own count', () async {
    await seen.see('h', 's1', 3);
    await seen.see('h', 's2', 1);
    await seen.see('g', 's1', 9);
    expect(seen.unread('h', win('s1', 4)), 1);
    expect(seen.unread('h', win('s2', 4)), 3);
    expect(seen.unread('g', win('s1', 4)), 0);
  });

  test('no session or no replies is not unread', () {
    expect(seen.unread('h', win(null, 5)), 0);
    expect(seen.unread('h', win('s1', null)), 0);
  });

  test(
    'replies that drop reset the stored count: later ones are unread',
    () async {
      await seen.see('h', 's1', 8);
      expect(seen.unread('h', win('s1', 2)), 0);
      seen.observe('h', [win('s1', 2)]);
      expect(seen.seenOf('h', 's1'), 2);
      expect(seen.unread('h', win('s1', 3)), 1);
      final again = await Seen.load(v);
      expect(again.seenOf('h', 's1'), 2);
    },
  );

  test('a stored value is kept while the window is offline', () async {
    await seen.see('h', 's1', 6);
    final again = await Seen.load(v);
    expect(again.unread('h', win('s1', 6)), 0);
  });

  test('unreadable storage starts empty', () async {
    v.values['nb.seen'] = 'not json';
    final s = await Seen.load(v);
    expect(s.seenOf('h', 's1'), 0);
  });
  test('the 200 most recently updated sessions of a host are kept', () async {
    for (var i = 0; i < 205; i++) {
      await seen.see('h', 's$i', i + 1);
      if (i == 150) await seen.see('h', 's0', 99); // updated again: stays
    }
    await seen.see('g', 's0', 4);
    expect(seen.seenOf('h', 's0'), 99);
    expect(seen.seenOf('h', 's1'), 0);
    expect(seen.seenOf('h', 's5'), 0);
    expect(seen.seenOf('h', 's6'), 7);
    expect(seen.seenOf('h', 's204'), 205);
    expect(seen.seenOf('g', 's0'), 4);
    final again = await Seen.load(v);
    expect(again.seenOf('h', 's1'), 0);
    expect(again.seenOf('h', 's204'), 205);
  });

  test('prune drops the hosts that are gone', () async {
    await seen.see('h', 's1', 3);
    await seen.see('g', 's1', 4);
    seen.prune({'g'});
    expect(seen.seenOf('h', 's1'), 0);
    expect(seen.seenOf('g', 's1'), 4);
    await Future<void>.delayed(Duration.zero);
    expect((await Seen.load(v)).seenOf('h', 's1'), 0);
  });

  test(
    'watch: the host stream records first sight, forgetting prunes',
    () async {
      final id = await Identity.load(MemoryVault());
      final hv = MemoryVault();
      final hosts = await Hosts.load(hv);
      final f = FakeFactory();
      final links = Links(
        hosts,
        f.factory,
        id,
        sleep: (_) => Completer<void>().future,
      );
      seen.watch(hosts, links);
      final hid = b64u(List.filled(32, 1));
      final host = PairedHost(
        id: hid,
        relay: Uri.parse('wss://relay.example.com'),
        label: 'laptop',
        pairedAt: DateTime(2026),
      );
      f.results.add(FakeChannel([win('s1', 4)]));
      await hosts.add(host);
      for (var i = 0; i < 10; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(seen.seenOf(hid, 's1'), 4);
      await hosts.forget(hid);
      expect(seen.seenOf(hid, 's1'), 0);
      links.dispose();
      seen.dispose();
    },
  );
}
