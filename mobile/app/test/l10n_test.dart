import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

Map<String, String> arbs() => {
  for (final f in Directory('lib/l10n').listSync().whereType<File>())
    if (f.path.endsWith('.arb'))
      RegExp(r'app_(.+)\.arb$').firstMatch(f.path)![1]!: f.readAsStringSync(),
};

void main() {
  test('every language has the same keys', () {
    final keys = arbs().map(
      (lang, text) => MapEntry(lang, {
        for (final k in (jsonDecode(text) as Map<String, Object?>).keys)
          if (!k.startsWith('@')) k,
      }),
    );
    final en = keys['en']!;
    expect(en, isNotEmpty);
    for (final MapEntry(:key, :value) in keys.entries) {
      expect(value, en, reason: 'app_$key.arb');
    }
  });

  // zh-CN and pt-BR are the base files app_zh and app_pt: Flutter needs a language file under a regional one, and
  // Nota Bene has one variant of each (as the web does)
  test('the languages are UI_LANGS', () {
    final src = File('../../shared/src/lang.ts').readAsStringSync();
    final list = RegExp(r"UI_LANGS = \[([^\]]+)\]").firstMatch(src)![1]!;
    final langs = {
      for (final m in RegExp(r"'([^']+)'").allMatches(list))
        m[1]!.split('-').first,
    };
    expect(arbs().keys.toSet(), langs);
  });
}
