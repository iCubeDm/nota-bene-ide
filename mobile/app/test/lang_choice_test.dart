import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/settings_screen.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/lang_choice.dart';
import 'package:nb_app/store/theme_choice.dart';
import 'package:nb_app/store/vault.dart';

void main() {
  test(
    'the phone\'s language until one is chosen; the choice is kept',
    () async {
      final v = MemoryVault();
      final a = await LangChoice.load(v);
      expect(a.code, isNull);
      expect(a.locale, isNull);
      await a.choose('ru');
      expect(a.locale, const Locale('ru'));
      expect((await LangChoice.load(v)).code, 'ru');
      await a.choose(null);
      expect(await v.read('lang'), isNull);
      expect((await LangChoice.load(v)).code, isNull);
    },
  );

  test('a language Nota Bene does not have is the phone\'s', () async {
    final v = MemoryVault();
    await v.write('lang', 'fr');
    expect((await LangChoice.load(v)).code, isNull);
  });

  testWidgets('a language picked in Settings is applied at once and kept', (
    t,
  ) async {
    final v = MemoryVault();
    final langs = await LangChoice.load(v);
    final themes = await ThemeChoice.load(v);
    await t.pumpWidget(
      NbApp(
        themes: themes,
        langs: langs,
        home: SettingsScreen(
          identity: await Identity.load(v),
          hosts: await Hosts.load(v),
          themes: themes,
          langs: langs,
          onPair: () {},
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(find.text('Settings'), findsOneWidget);
    expect(find.text("Phone's language"), findsOneWidget);
    await t.tap(find.byKey(const ValueKey('language')));
    await t.pumpAndSettle();
    // the six by their own names, after the phone's
    for (final (_, name) in appLangs) {
      expect(find.text(name), findsOneWidget);
    }
    await t.tap(find.text('Русский'));
    await t.pumpAndSettle();
    expect(find.text('Настройки'), findsOneWidget);
    expect(find.text('Русский'), findsOneWidget);
    expect(await v.read('lang'), 'ru');
    await t.tap(find.byKey(const ValueKey('language')));
    await t.pumpAndSettle();
    await t.tap(find.text('Как на телефоне'));
    await t.pumpAndSettle();
    // the test's phone speaks English
    expect(find.text('Settings'), findsOneWidget);
    expect(await v.read('lang'), isNull);
  });
}
