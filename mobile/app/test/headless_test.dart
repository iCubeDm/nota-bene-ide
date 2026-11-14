import 'dart:async';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/l10n/app_localizations.dart';
import 'package:nb_app/notify/headless.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/notify_choice.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

HostWindow w(int replies, {String root = '/home/u/notes'}) => HostWindow(
  port: 4791,
  provider: 'claude',
  root: root,
  session: 's1',
  replies: replies,
  last: LastMessage(role: 'assistant', text: 'Ready.'),
);

void main() {
  final en = lookupAppLocalizations(const Locale('en'));

  Future<MemoryVault> paired(List<String> ids) async {
    final v = MemoryVault();
    await Identity.load(v);
    final hosts = await Hosts.load(v);
    for (final id in ids) {
      await hosts.add(
        PairedHost(
          id: id,
          relay: Uri.parse('wss://relay.example.com'),
          label: id,
          pairedAt: DateTime(2026),
        ),
      );
    }
    return v;
  }

  final a = b64u(List.filled(32, 1)), b = b64u(List.filled(32, 2));

  test(
    'a host with a new reply gives one notification; every channel closes after',
    () async {
      final v = await paired([a]);
      final seen = await Seen.load(v);
      seen.observe(a, [w(1)]);
      final f = FakeFactory();
      final ch = FakeChannel([w(2)]);
      f.results.add(ch);
      final p = FakeBackground();
      await runCheck(vault: v, connect: f.factory, platform: p, strings: en);
      final n = p.of('notify').single;
      expect((n['title'], n['text'], n['hostId']), ('notes', 'Ready.', a));
      expect(ch.isClosed, isTrue);
      // the same reply is not notified by the next check
      f.results.add(FakeChannel([w(2)]));
      await runCheck(vault: v, connect: f.factory, platform: p, strings: en);
      expect(p.of('notify'), hasLength(1));
    },
  );

  test(
    'an unreachable host gives nothing and does not hold up the others',
    () async {
      final v = await paired([a, b]);
      final seen = await Seen.load(v);
      seen.observe(b, [w(1, root: '/home/u/web')]);
      final f = FakeFactory();
      f.results.addAll([
        Completer<Channel>().future, // a: the relay never answers
        FakeChannel([w(2, root: '/home/u/web')]),
      ]);
      final p = FakeBackground();
      final took = Stopwatch()..start();
      await runCheck(
        vault: v,
        connect: f.factory,
        platform: p,
        strings: en,
        wait: const Duration(milliseconds: 200),
      );
      expect(took.elapsed, lessThan(const Duration(seconds: 2)));
      expect(p.of('notify').single['hostId'], b);
    },
  );

  test(
    'notifications turned off in Settings: the check posts nothing',
    () async {
      final v = await paired([a]);
      (await Seen.load(v)).observe(a, [w(1)]);
      await (await NotifyChoice.load(v)).set(false);
      final f = FakeFactory()..results.add(FakeChannel([w(2)]));
      final p = FakeBackground();
      await runCheck(vault: v, connect: f.factory, platform: p, strings: en);
      expect(p.of('notify'), isEmpty);
      expect(f.calls, isEmpty, reason: 'it does not even connect');
    },
  );

  test('a list that comes after the connection is still read', () async {
    final v = await paired([a]);
    (await Seen.load(v)).observe(a, [w(1)]);
    final late = FakeChannel(); // connected, the host's list not sent yet
    final f = FakeFactory()..results.add(late);
    final p = FakeBackground();
    Timer(const Duration(milliseconds: 50), () => late.push([w(2)]));
    await runCheck(vault: v, connect: f.factory, platform: p, strings: en);
    expect(p.of('notify'), hasLength(1));
  });
}
