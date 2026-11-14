import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/l10n/app_localizations.dart';
import 'package:nb_app/notify/background.dart';
import 'package:nb_app/notify/visible.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/notified.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

const root = '/home/u/notes';

HostWindow w({
  bool busy = false,
  bool pending = false,
  int replies = 1,
  String? text,
}) => HostWindow(
  port: 4791,
  provider: 'claude',
  root: root,
  session: 's1',
  busy: busy,
  pending: pending,
  replies: replies,
  last: text == null ? null : LastMessage(role: 'assistant', text: text),
);

class Kit {
  late FakeFactory f;
  late FakeChannel ch;
  late Links links;
  late Seen seen;
  late Notified notified;
  late AppVisible visible;
  late FakeBackground platform;
  late Background bg;
  late String hostId;
  var explained = 0;

  HostLink get link => links.all.single;

  Future<void> start(
    WidgetTester t, {
    String answer = 'granted',
    bool allow = true,
    List<HostWindow>? first,
  }) async {
    final v = MemoryVault();
    final hosts = await Hosts.load(v);
    hostId = b64u(List.filled(32, 1));
    await hosts.add(
      PairedHost(
        id: hostId,
        relay: Uri.parse('wss://relay.example.com'),
        label: 'h',
        pairedAt: DateTime(2026),
      ),
    );
    f = FakeFactory();
    ch = FakeChannel(first ?? [w()]);
    f.results.add(ch);
    links = Links(
      hosts,
      f.factory,
      await Identity.load(MemoryVault()),
      sleep: (_) => Completer<void>().future,
    );
    seen = await Seen.load(v);
    seen.watch(hosts, links);
    notified = await Notified.load(v);
    visible = AppVisible.test();
    platform = FakeBackground(answer: answer, allow: allow);
    bg = Background(
      links: links,
      seen: seen,
      notified: notified,
      visible: visible,
      platform: platform,
      strings: () => lookupAppLocalizations(const Locale('en')),
      explain: () async {
        explained++;
        return true;
      },
    );
    await t.pump();
    await t.pump();
  }

  void dispose() {
    bg.dispose();
    links.dispose();
  }
}

void main() {
  testWidgets(
    'a busy window while visible starts the service; quiet for 5 minutes stops it and pauses hidden links',
    (t) async {
      final k = Kit();
      await k.start(t);
      k.ch.push([w(busy: true)]);
      await t.pump();
      await t.pump();
      expect(k.platform.of('startService').single['text'], '1 agent working');
      expect(k.bg.serviceOn, isTrue);
      k.visible.visible = false;
      await t.pump(const Duration(minutes: 20));
      expect(k.link.running, isTrue, reason: 'the service holds the links');
      k.ch.push([w()]);
      await t.pump();
      await t.pump(const Duration(minutes: 4));
      expect(k.platform.of('stopService'), isEmpty);
      await t.pump(const Duration(minutes: 1, seconds: 1));
      expect(k.platform.of('stopService'), hasLength(1));
      expect(k.bg.serviceOn, isFalse);
      expect(k.link.running, isFalse);
      k.dispose();
    },
  );

  testWidgets(
    'hiding with no agent working pauses the links; showing resumes them',
    (t) async {
      final k = Kit();
      await k.start(t);
      k.visible.visible = false;
      await t.pump(const Duration(minutes: 9));
      expect(k.link.running, isTrue, reason: 'a quick switch keeps the links');
      await t.pump(const Duration(minutes: 1, seconds: 1));
      expect(k.link.running, isFalse);
      k.f.results.add(FakeChannel([w()]));
      k.visible.visible = true;
      await t.pump();
      expect(k.link.running, isTrue);
      k.dispose();
    },
  );

  testWidgets(
    'a reply on a hidden phone posts one notification with the project and text; opening that chat cancels it',
    (t) async {
      final k = Kit();
      await k.start(t);
      k.visible.open(k.hostId, 4791, root);
      k.visible.visible = false;
      k.ch.push([w(replies: 2, text: 'All done.')]);
      await t.pump();
      k.ch.push([w(replies: 2, text: 'All done.')]);
      await t.pump();
      final n = k.platform.of('notify').single;
      expect(n['title'], 'notes');
      expect(n['text'], 'All done.');
      expect(n['publicTitle'], 'New reply in notes');
      expect((n['hostId'], n['port'], n['root']), (k.hostId, 4791, root));
      expect(n['tag'], '${k.hostId} s1');
      final before = k.platform.of('cancel').length;
      k.visible.visible = true;
      await t.pump();
      expect(
        k.platform.of('cancel').skip(before).map((c) => c['tag']),
        ['${k.hostId} s1'],
      );
      k.dispose();
    },
  );

  testWidgets('a wait notifies with its own text', (t) async {
    final k = Kit();
    await k.start(t);
    k.visible.visible = false;
    k.ch.push([w(pending: true)]);
    await t.pump();
    final n = k.platform.of('notify').single;
    expect(n['text'], 'The agent waits for you');
    expect(n['publicTitle'], 'notes: the agent waits for you');
    k.dispose();
  });

  testWidgets(
    'notifications denied: no service start, no notification, the links behave as before',
    (t) async {
      final k = Kit();
      await k.start(t, answer: 'denied');
      k.ch.push([w(busy: true)]);
      await t.pump();
      k.visible.visible = false;
      k.ch.push([w(busy: true, replies: 2)]);
      await t.pump();
      expect(k.platform.of('startService'), isEmpty);
      expect(k.platform.of('notify'), isEmpty);
      expect(
        k.platform.of('schedule').map((c) => c['on']),
        isNot(contains(true)),
      );
      await t.pump(const Duration(minutes: 10, seconds: 1));
      expect(k.link.running, isFalse);
      k.dispose();
    },
  );

  testWidgets('asking first explains, then asks Android, once', (t) async {
    final k = Kit();
    await k.start(t, answer: 'ask', allow: false);
    k.ch.push([w(busy: true)]);
    await t.pump();
    k.ch.push([w(busy: true, replies: 2)]);
    await t.pump();
    expect(k.explained, 1);
    expect(k.platform.of('requestPermission'), hasLength(1));
    expect(k.platform.of('startService'), isEmpty);
    k.dispose();
  });

  testWidgets('check while paused resumes, notifies, and pauses again', (
    t,
  ) async {
    final k = Kit();
    await k.start(t);
    k.visible.visible = false;
    await t.pump(const Duration(minutes: 10, seconds: 1));
    expect(k.link.running, isFalse);
    k.f.results.add(FakeChannel([w(replies: 2, text: 'Found it.')]));
    await k.bg.check();
    await t.pump();
    expect(k.platform.of('notify').single['text'], 'Found it.');
    expect(k.link.running, isFalse);
    k.dispose();
  });

  testWidgets(
    'the setting off stops the service, cancels the schedule and posts nothing',
    (t) async {
      final k = Kit();
      await k.start(t);
      expect(k.platform.of('schedule').map((c) => c['on']), [true]);
      k.ch.push([w(busy: true)]);
      await t.pump();
      await k.bg.setEnabled(false);
      expect(k.platform.of('stopService'), hasLength(1));
      expect(k.platform.of('schedule').map((c) => c['on']), [true, false]);
      k.visible.visible = false;
      k.ch.push([w(busy: true, replies: 2)]);
      await t.pump();
      expect(k.platform.of('notify'), isEmpty);
      expect(k.platform.of('startService'), hasLength(1));
      k.dispose();
    },
  );
}
