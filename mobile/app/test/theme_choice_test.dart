import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/store/theme_choice.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_app/theme.dart';

void main() {
  test('Darcula until one is chosen; the choice is kept', () async {
    final v = MemoryVault();
    final a = await ThemeChoice.load(v);
    expect(a.theme, NbTheme.darcula);
    var told = 0;
    a.addListener(() => told++);
    await a.choose(NbTheme.solarizedLight);
    expect(a.theme, NbTheme.solarizedLight);
    expect(told, 1);
    expect((await ThemeChoice.load(v)).theme, NbTheme.solarizedLight);
  });

  test('an unknown saved theme falls back to Darcula', () async {
    final v = MemoryVault()..values['theme'] = 'neon';
    expect((await ThemeChoice.load(v)).theme, NbTheme.darcula);
  });

  testWidgets('the app wears the chosen theme and follows a change', (t) async {
    final choice = await ThemeChoice.load(MemoryVault());
    late BuildContext ctx;
    await t.pumpWidget(
      NbApp(
        themes: choice,
        home: Builder(
          builder: (c) {
            ctx = c;
            return const Scaffold();
          },
        ),
      ),
    );
    expect(Theme.of(ctx).extension<NbColors>(), NbTheme.darcula.colors);
    await choice.choose(NbTheme.githubLight);
    await t.pumpAndSettle();
    expect(Theme.of(ctx).brightness, Brightness.light);
    expect(Theme.of(ctx).extension<NbColors>(), NbTheme.githubLight.colors);
  });
}
