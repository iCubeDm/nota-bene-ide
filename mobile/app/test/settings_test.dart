import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/settings_screen.dart';
import 'package:nb_app/store/notify_choice.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/theme_choice.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

void main() {
  notifyTests();
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
        home: SettingsScreen(
          identity: id,
          hosts: hosts,
          themes: await ThemeChoice.load(v),
          onPair: () {},
        ),
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

  testWidgets('a theme picked in Settings is applied and kept', (t) async {
    final v = MemoryVault();
    final id = await Identity.load(v);
    final hosts = await Hosts.load(v);
    final themes = await ThemeChoice.load(v);
    await t.pumpWidget(
      NbApp(
        themes: themes,
        home: SettingsScreen(
          identity: id,
          hosts: hosts,
          themes: themes,
          onPair: () {},
        ),
      ),
    );
    await t.pumpAndSettle();
    for (final th in NbTheme.values) {
      await t.scrollUntilVisible(
        find.text(th.label),
        100,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text(th.label), findsOneWidget);
    }
    await t.tap(find.text('Solarized Dark'));
    await t.pumpAndSettle();
    expect(themes.theme, NbTheme.solarizedDark);
    expect(
      Theme.of(t.element(find.text('Solarized Dark'))).extension<NbColors>(),
      NbTheme.solarizedDark.colors,
    );
    expect((await ThemeChoice.load(v)).theme, NbTheme.solarizedDark);
  });

  testWidgets('a host row in Settings opens Rename host (tap or long-press)', (
    t,
  ) async {
    final v = MemoryVault();
    final id = await Identity.load(v);
    final hosts = await Hosts.load(v);
    await hosts.add(
      PairedHost(
        id: b64u(List.filled(32, 1)),
        relay: Uri.parse('wss://r.example'),
        label: 'laptop',
        pairedAt: DateTime(2026),
        computerName: 'studio-mac',
      ),
    );
    await t.pumpWidget(
      NbApp(
        home: SettingsScreen(
          identity: id,
          hosts: hosts,
          themes: await ThemeChoice.load(v),
          onPair: () {},
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.longPress(find.text('studio-mac'));
    await t.pumpAndSettle();
    expect(find.text('Rename host'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'Desk');
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    expect(find.text('Desk'), findsOneWidget);
    expect((await Hosts.load(v)).byId(hosts.all.single.id)!.label, 'Desk');
  });

  testWidgets('themes are grouped: dark first, then light, under headings', (
    t,
  ) async {
    final v = MemoryVault();
    t.view.physicalSize = const Size(800, 4000); // every row built at once
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(
      NbApp(
        home: SettingsScreen(
          identity: await Identity.load(v),
          hosts: await Hosts.load(v),
          themes: await ThemeChoice.load(v),
          onPair: () {},
        ),
      ),
    );
    await t.pumpAndSettle();
    final order = [
      'Dark themes',
      'Darcula',
      'Plannotator',
      'Solarized Dark',
      'Light themes',
      'IntelliJ Light',
      'GitHub Light',
      'Solarized Light',
    ];
    final ys = [for (final s in order) t.getTopLeft(find.text(s)).dy];
    expect([...ys]..sort(), ys, reason: 'dark first, then light, as designed');
    expect(ys.toSet(), hasLength(order.length));
  });
}

void notifyTests() {
  Future<(NotifyChoice, FakeBackground, List<bool>)> open(
    WidgetTester t, {
    String answer = 'granted',
  }) async {
    final v = MemoryVault();
    final choice = await NotifyChoice.load(v);
    final platform = FakeBackground(answer: answer);
    final applied = <bool>[];
    await t.pumpWidget(
      NbApp(
        home: SettingsScreen(
          identity: await Identity.load(v),
          hosts: await Hosts.load(v),
          themes: await ThemeChoice.load(v),
          onPair: () {},
          notify: NotifySettings(
            choice: choice,
            platform: platform,
            apply: (on) async => applied.add(on),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    return (choice, platform, applied);
  }

  testWidgets('the notifications switch is on by default and turns them off', (
    t,
  ) async {
    final (choice, _, applied) = await open(t);
    final row = find.byKey(const ValueKey('notify'));
    expect(row, findsOneWidget);
    expect(t.widget<SwitchListTile>(row).value, isTrue);
    expect(
      find.text(
        'Notifications are turned off for Nota Bene in Android\'s settings.',
      ),
      findsNothing,
    );
    await t.tap(row);
    await t.pumpAndSettle();
    expect(choice.on, isFalse);
    expect(applied, [false]);
    expect(t.widget<SwitchListTile>(row).value, isFalse);
  });

  testWidgets(
    'with notifications denied by Android, a hint and a way to the settings',
    (t) async {
      final (_, platform, _) = await open(t, answer: 'denied');
      expect(
        find.text(
          'Notifications are turned off for Nota Bene in Android\'s settings.',
        ),
        findsOneWidget,
      );
      await t.tap(find.text('Open settings'));
      expect(platform.of('openSettings'), hasLength(1));
    },
  );

  test('the choice is kept', () async {
    final v = MemoryVault();
    await (await NotifyChoice.load(v)).set(false);
    expect((await NotifyChoice.load(v)).on, isFalse);
  });
}
