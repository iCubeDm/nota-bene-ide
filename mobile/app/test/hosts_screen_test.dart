import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/home.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/store/hosts.dart';
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

  setUp(() async {
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
      expect(find.text('notes'), findsOneWidget);
      expect(find.textContaining('Plan · claude · opus'), findsOneWidget);
      expect(find.text('site'), findsOneWidget);
      expect(find.textContaining('Offline'), findsOneWidget);
      links.dispose();
    },
  );

  testWidgets('tapping a window opens its chat', (t) async {
    await hosts.add(paired(a, 'laptop'));
    f.results.add(FakeChannel([window(4791, '/home/u/notes')]));
    final opened = <String>[];
    final links = await pump(t, opened: opened);
    await t.tap(find.text('notes'));
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
    expect(find.text('notes'), findsOneWidget);
    links.dispose();
  });

  test('LinkState has the four states', () {
    expect(LinkState.values, hasLength(4));
  });
}
