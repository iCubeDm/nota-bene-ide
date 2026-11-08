import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/settings_screen.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

void main() {
  testWidgets('forget asks, removes the host and stops its link', (t) async {
    final v = MemoryVault();
    final id = await Identity.load(v);
    final hosts = await Hosts.load(v);
    final h = PairedHost(
      id: b64u(List.filled(32, 1)),
      relay: Uri.parse('wss://r.example'),
      label: 'laptop',
      pairedAt: DateTime(2026),
    );
    await hosts.add(h);
    final f = FakeFactory();
    final ch = FakeChannel([window(4791, '/p')]);
    f.results.add(ch);
    final links = Links(
      hosts,
      f.factory,
      id,
      sleep: (_) => Completer<void>().future,
    );
    await t.pumpWidget(
      NbApp(
        home: SettingsScreen(identity: id, hosts: hosts, onPair: () {}),
      ),
    );
    await t.pumpAndSettle();
    expect(find.text('laptop'), findsOneWidget);
    expect(find.text(await id.fingerprint), findsOneWidget);
    await t.tap(find.text('Forget'));
    await t.pumpAndSettle();
    expect(hosts.all, hasLength(1), reason: 'not before the confirmation');
    await t.tap(find.widgetWithText(FilledButton, 'Forget'));
    await t.pumpAndSettle();
    expect(hosts.all, isEmpty);
    expect(links.of(h.id), isNull);
    expect(ch.isClosed, isTrue, reason: 'its connection is closed');
    expect(find.text('laptop'), findsNothing);
    links.dispose();
  });
}
