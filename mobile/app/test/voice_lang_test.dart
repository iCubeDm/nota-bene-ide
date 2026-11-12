import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/settings_screen.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/lang_choice.dart';
import 'package:nb_app/store/theme_choice.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_app/store/voice_lang.dart';

void main() {
  test('Automatic until one is pinned; the pin is kept', () async {
    final v = MemoryVault();
    final a = await VoiceLang.load(v);
    expect(a.code, VoiceLang.auto);
    expect(a.isAuto, isTrue);
    await a.choose('ru');
    expect(a.code, 'ru');
    expect(a.isAuto, isFalse);
    expect((await VoiceLang.load(v)).code, 'ru');
    await a.choose(VoiceLang.auto);
    expect(await v.read('voiceLang'), isNull);
    expect((await VoiceLang.load(v)).code, VoiceLang.auto);
  });

  test('the stored null (the old app-language default) migrates to auto; a pin '
      'stays pinned', () async {
    // nothing stored was "app language"; it is Automatic now
    expect((await VoiceLang.load(MemoryVault())).isAuto, isTrue);
    final v = MemoryVault()..values['voiceLang'] = 'de';
    expect((await VoiceLang.load(v)).code, 'de');
  });

  test('a language Whisper is not asked for is not kept', () async {
    final v = MemoryVault();
    await v.write('voiceLang', 'fr');
    expect((await VoiceLang.load(v)).isAuto, isTrue);
  });

  Future<String> lang(WidgetTester t, VoiceLang? v) async {
    late String got;
    await t.pumpWidget(
      NbApp(
        voiceLang: v,
        home: Builder(
          builder: (c) {
            got = voiceLangOf(c);
            return const SizedBox();
          },
        ),
      ),
    );
    return got;
  }

  testWidgets('the app language without a choice; the choice over it', (
    t,
  ) async {
    expect(await lang(t, null), 'en');
    final v = await VoiceLang.load(MemoryVault());
    expect(await lang(t, v), 'en');
    await v.choose('ru');
    expect(await lang(t, v), 'ru');
  });

  testWidgets('detect only under Automatic', (t) async {
    late bool got;
    final v = await VoiceLang.load(MemoryVault());
    Future<bool> detect() async {
      await t.pumpWidget(
        NbApp(
          voiceLang: v,
          home: Builder(
            builder: (c) {
              got = voiceDetectOf(c);
              return const SizedBox();
            },
          ),
        ),
      );
      return got;
    }

    expect(await detect(), isTrue);
    await v.choose('ru');
    expect(await detect(), isFalse);
  });

  testWidgets('the app in Russian and no choice: Russian', (t) async {
    late String got;
    await t.pumpWidget(
      NbApp(
        langs: await LangChoice.load(MemoryVault()..values['lang'] = 'ru'),
        voiceLang: await VoiceLang.load(MemoryVault()),
        home: Builder(
          builder: (c) {
            got = voiceLangOf(c);
            return const SizedBox();
          },
        ),
      ),
    );
    expect(got, 'ru');
  });

  testWidgets('picked in Settings, in each language\'s own name, and kept', (
    t,
  ) async {
    final v = MemoryVault();
    final themes = await ThemeChoice.load(v);
    final voice = await VoiceLang.load(v);
    await t.pumpWidget(
      NbApp(
        themes: themes,
        voiceLang: voice,
        home: SettingsScreen(
          identity: await Identity.load(v),
          hosts: await Hosts.load(v),
          themes: themes,
          langs: await LangChoice.load(v),
          voiceLang: voice,
          onPair: () {},
        ),
      ),
    );
    await t.pumpAndSettle();
    final row = find.byKey(const ValueKey('voice-language'));
    await t.scrollUntilVisible(
      row,
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Voice language'), findsOneWidget);
    // the subtitle names the current choice
    expect(find.text('Automatic'), findsOneWidget);
    await t.tap(row);
    await t.pumpAndSettle();
    // Automatic first, then the six
    expect(
      t.getTopLeft(find.text('Automatic').last).dy,
      lessThan(t.getTopLeft(find.text('English')).dy),
    );
    for (final name in [
      'English',
      'Русский',
      '中文',
      'Español',
      'Português',
      'Deutsch',
    ]) {
      expect(find.text(name), findsOneWidget);
    }
    await t.tap(find.text('Русский'));
    await t.pumpAndSettle();
    expect(voice.code, 'ru');
    expect(await v.read('voiceLang'), 'ru');
    // the app itself stays in English
    expect(find.text('Settings'), findsOneWidget);
    expect(find.text('Русский'), findsOneWidget);
  });
}
