import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:nb_app/home.dart';
import 'package:nb_app/hosts/hosts_screen.dart' show rowTime;
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

final a = b64u(List.filled(32, 1)), b = b64u(List.filled(32, 2));

PairedHost paired(String id, String label) => PairedHost(
  id: id,
  relay: Uri.parse('wss://relay.example.com'),
  label: label,
  pairedAt: DateTime(2026),
);

void main() {
  late Identity id;
  late Hosts hosts;
  late FakeFactory f;
  late Seen seen;
  final now = DateTime(2026, 11, 9, 15, 30);

  setUpAll(() => initializeDateFormatting('en'));

  setUp(() async {
    seen = await Seen.load(MemoryVault());
    final v = MemoryVault();
    id = await Identity.load(v);
    hosts = await Hosts.load(v);
    f = FakeFactory();
  });

  Future<Links> pump(WidgetTester t, {List<String>? opened}) async {
    final links = Links(
      hosts,
      f.factory,
      id,
      sleep: (_) => Completer<void>().future,
    );
    await t.pumpWidget(
      NbApp(
        home: Home(
          hosts: hosts,
          seen: seen,
          clock: () => now,
          links: links,
          onPair: () {},
          chat: (hostId, w) {
            opened?.add('$hostId ${w.port}');
            return Scaffold(body: Text('chat ${w.root}'));
          },
        ),
      ),
    );
    await t.pumpAndSettle();
    return links;
  }

  testWidgets('no hosts: an empty state with Pair a host', (t) async {
    final links = await pump(t);
    expect(find.text('Pair a host'), findsWidgets);
    links.dispose();
  });

  testWidgets(
    'the screen groups windows by host and shows an offline host as offline',
    (t) async {
      await hosts.add(paired(a, 'laptop'));
      await hosts.add(paired(b, 'desktop'));
      f.results
        ..add(
          FakeChannel([
            window(
              4791,
              '/home/u/notes',
              title: 'Plan',
              model: 'opus',
              busy: true,
            ),
            window(4792, '/home/u/site'),
          ]),
        )
        ..add(ChannelError('no answer'));
      final links = await pump(t);
      expect(find.text('laptop'), findsOneWidget);
      expect(find.text('desktop'), findsOneWidget);
      expect(find.text('Plan'), findsOneWidget);
      expect(find.textContaining('notes · opus'), findsOneWidget);
      expect(find.textContaining('site'), findsOneWidget);
      expect(find.textContaining('Offline'), findsOneWidget);
      links.dispose();
    },
  );

  testWidgets('tapping a window opens its chat', (t) async {
    await hosts.add(paired(a, 'laptop'));
    f.results.add(FakeChannel([window(4791, '/home/u/notes')]));
    final opened = <String>[];
    final links = await pump(t, opened: opened);
    await t.tap(find.textContaining('notes'));
    await t.pumpAndSettle();
    expect(opened, ['$a 4791']);
    expect(hosts.lastChat, '$a 4791 /home/u/notes');
    links.dispose();
  });

  testWidgets('a host that revoked this phone says so and offers Forget', (
    t,
  ) async {
    await hosts.add(paired(a, 'laptop'));
    f.results.add(ChannelError('closed', relayCode: 4403));
    final links = await pump(t);
    expect(find.textContaining('no longer paired'), findsOneWidget);
    await t.tap(find.text('Forget'));
    await t.pumpAndSettle();
    expect(hosts.all, isEmpty);
    links.dispose();
  });

  testWidgets(
    'Home opens the last chat only when its host is online and lists it',
    (t) async {
      await hosts.add(paired(a, 'laptop'));
      await hosts.setLastChat('$a 4791 /home/u/notes');
      f.results.add(FakeChannel([window(4791, '/home/u/notes')]));
      final opened = <String>[];
      final links = await pump(t, opened: opened);
      expect(opened, ['$a 4791']);
      expect(find.text('chat /home/u/notes'), findsOneWidget);
      links.dispose();
    },
  );

  testWidgets('Home stays on the list when the last chat is gone', (t) async {
    await hosts.add(paired(a, 'laptop'));
    await hosts.setLastChat('$a 4799 /home/u/old');
    f.results.add(FakeChannel([window(4791, '/home/u/notes')]));
    final opened = <String>[];
    final links = await pump(t, opened: opened);
    expect(opened, isEmpty);
    expect(find.textContaining('notes'), findsOneWidget);
    links.dispose();
  });

  HostWindow full({
    bool pending = false,
    String role = 'assistant',
    int replies = 5,
  }) => HostWindow(
    port: 4791,
    provider: 'claude',
    root: '/home/u/notes',
    title: 'Plan',
    session: 's1',
    model: 'opus',
    busy: true,
    pending: pending,
    replies: replies,
    last: LastMessage(role: role, text: 'Done, see the diff', at: now),
  );

  Future<Links> pumpOne(WidgetTester t, HostWindow w, {int seenTo = 2}) async {
    await hosts.add(paired(a, 'laptop'));
    await seen.see(a, 's1', seenTo);
    f.results.add(FakeChannel([w]));
    return pump(t);
  }

  testWidgets('a row shows title, time, last text, count, folder and model', (
    t,
  ) async {
    final links = await pumpOne(t, full());
    expect(find.text('Plan'), findsOneWidget);
    expect(find.text('15:30'), findsOneWidget);
    expect(find.text('Done, see the diff'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(find.text('!'), findsNothing);
    expect(find.text('C'), findsOneWidget);
    expect(find.textContaining('notes · opus'), findsOneWidget);
    links.dispose();
  });

  testWidgets('a waiting window shows ! instead of the count', (t) async {
    final links = await pumpOne(t, full(pending: true));
    expect(find.text('!'), findsOneWidget);
    expect(find.text('3'), findsNothing);
    links.dispose();
  });

  testWidgets('a user message is prefixed with You', (t) async {
    final links = await pumpOne(t, full(role: 'user'));
    expect(find.text('You: Done, see the diff'), findsOneWidget);
    links.dispose();
  });

  testWidgets('a window without the new fields shows no preview or badge', (
    t,
  ) async {
    await hosts.add(paired(a, 'laptop'));
    f.results.add(FakeChannel([window(4791, '/home/u/notes')]));
    final links = await pump(t);
    expect(find.text('untitled'), findsOneWidget);
    expect(find.text('!'), findsNothing);
    expect(find.textContaining('You:'), findsNothing);
    expect(find.textContaining('notes'), findsOneWidget);
    links.dispose();
  });

  test('older messages show the weekday, then the date', () {
    expect(rowTime(DateTime(2026, 11, 6, 9), now, 'en'), 'Fri');
    expect(rowTime(DateTime(2026, 10, 20, 9), now, 'en'), '20.10');
    expect(rowTime(DateTime(2026, 11, 9, 8, 5), now, 'en'), '08:05');
  });

  testWidgets('long-press, Mark read clears the count', (t) async {
    final links = await pumpOne(t, full());
    await t.longPress(find.text('Plan'));
    await t.pumpAndSettle();
    expect(find.text('Open'), findsOneWidget);
    await t.tap(find.text('Mark read'));
    await t.pumpAndSettle();
    expect(seen.seenOf(a, 's1'), 5);
    expect(find.text('3'), findsNothing);
    links.dispose();
  });

  testWidgets('long-press, Open opens the chat', (t) async {
    await hosts.add(paired(a, 'laptop'));
    f.results.add(FakeChannel([full()]));
    final opened = <String>[];
    final links = await pump(t, opened: opened);
    await t.longPress(find.text('Plan'));
    await t.pumpAndSettle();
    await t.tap(find.text('Open'));
    await t.pumpAndSettle();
    expect(opened, ['$a 4791']);
    links.dispose();
  });

  testWidgets('an offline host keeps its rows, dimmed, with when it was seen', (
    t,
  ) async {
    await hosts.add(paired(a, 'laptop'));
    final ch = FakeChannel([full()]);
    f.results.add(ch);
    // the link runs in the real zone: a dropped channel is noticed by its timers, not by pumping
    final links = (await t.runAsync(() async {
      final l = Links(
        hosts,
        f.factory,
        id,
        sleep: (_) => Completer<void>().future,
      );
      await Future<void>.delayed(const Duration(milliseconds: 20));
      return l;
    }))!;
    await t.pumpWidget(
      NbApp(
        home: Home(
          hosts: hosts,
          seen: seen,
          clock: () => now,
          links: links,
          onPair: () {},
          chat: (_, w) => const Scaffold(),
        ),
      ),
    );
    await t.pumpAndSettle();
    const key = ValueKey('dim-4791');
    expect(t.widget<Opacity>(find.byKey(key)).opacity, 1);
    await t.runAsync(() async {
      ch.drop();
      await Future<void>.delayed(const Duration(milliseconds: 20));
    });
    await t.pumpAndSettle();
    expect(t.widget<Opacity>(find.byKey(key)).opacity, 0.5);
    expect(find.textContaining('Offline · seen'), findsOneWidget);
    expect(find.text('Plan'), findsOneWidget);
    links.dispose();
  });

  test('LinkState has the four states', () {
    expect(LinkState.values, hasLength(4));
  });
}
