import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:nb_app/usage/format.dart';

void main() {
  final fx =
      jsonDecode(File('test/fixtures/usage/format.json').readAsStringSync())
          as Map<String, Object?>;
  final pairs = [for (final p in fx['pairs'] as List) (p as List).cast<num>()];
  final tokens = (fx['tokens'] as List).cast<num>();
  final currencies = (fx['currencies'] as List).cast<String>();
  final models = (fx['models'] as List).cast<String>();
  final langs = (fx['langs'] as Map).cast<String, Map>();

  test('the formatters equal the desktop\'s in every app language', () {
    expect(langs.keys, ['en', 'ru', 'zh', 'es', 'pt', 'de']);
    for (final MapEntry(key: lang, value: want) in langs.entries) {
      expect(
        [for (final p in pairs) pct(p[0], p[1])],
        want['pct'],
        reason: 'pct $lang',
      );
      expect(
        [for (final p in pairs.where((p) => p[1] > 0)) part(p[0], p[1])],
        want['part'],
        reason: 'part $lang',
      );
      expect(
        [for (final n in tokens) fmtTokens(n, lang)],
        want['fmtTokens'],
        reason: 'fmtTokens $lang',
      );
      expect([for (final m in models) modelName(m)], want['modelName']);
      expect(fmtNum(1234567, lang), want['num'], reason: 'num $lang');
      expect(
        [money(12345, 'USD', lang), money(500, 'JPY', lang)],
        want['money'],
        reason: 'money $lang',
      );
      expect(
        [for (final c in currencies) money(12345, c, lang)],
        want['currencies'],
        reason: 'currencies $lang',
      );
    }
  });

  test('a null currency reads as dollars', () {
    expect(money(12345, null, 'en'), r'$123.45');
  });

  test('dates carry the day and the minutes', () async {
    await initializeDateFormatting();
    final ts = DateTime(2026, 11, 9, 14, 37).millisecondsSinceEpoch;
    for (final lang in langs.keys) {
      final s = when(ts, lang);
      expect(s, contains('9'), reason: lang);
      expect(s, contains('37'), reason: lang);
      expect(shortTime(ts, lang), contains('9'), reason: lang);
      expect(weekDay('2026-11-09', lang, 6), contains('15'), reason: lang);
    }
  });
}
