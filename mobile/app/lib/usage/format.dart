// The usage report's number and date formatters: ports of the desktop's (web/src/usage/UsageView.tsx), pinned by
// test/fixtures/usage/format.json, which the web side writes. [lang] is an app language code.
import 'dart:math' as math;

import 'package:intl/intl.dart';

String pct(num a, num b) => b > 0 ? '${(a / b * 100).round()}%' : '0%';

/// A part of the whole: a tiny one never reads as nothing.
String part(num a, num b) => a / b < 0.01 ? '<1%' : pct(a, b);

/// A count with the locale's grouping, as `toLocaleString` writes it. (`num` is a Dart type, hence the name.)
String fmtNum(num n, String lang) =>
    NumberFormat.decimalPattern(lang).format(n);

/// Large counts in the unit that reads best.
String fmtTokens(num n, String lang) {
  String unit(double v, String ru, String en) =>
      '${v.toStringAsFixed(1)}${lang == 'ru' ? ' $ru' : en}';
  return n >= 1e9
      ? unit(n / 1e9, 'млрд', 'B')
      : n >= 1e6
      ? unit(n / 1e6, 'млн', 'M')
      : n >= 1e3
      ? unit(n / 1e3, 'тыс', 'k')
      : '${n.round()}';
}

/// Symbols `intl` shares between currencies (`$` is a dozen of them); the desktop's ICU tells these apart.
const _shared = {'\$', '¥', '£', 'kr'};

/// The currencies whose bare shared symbol the desktop's ICU keeps in a language (`$` for USD in English).
const _bare = {
  'en': {'USD', 'JPY', 'GBP'},
  'ru': {'USD', 'JPY', 'GBP'},
  'de': {'USD', 'JPY', 'GBP'},
  'zh': {'CNY', 'GBP'},
  'es': <String>{},
  'pt': {'GBP'},
};

/// What ICU writes for the others: a prefixed symbol, or the ISO code where the language has none (Spanish).
String _icu(String lang, String code) {
  const prefixed = {
    'USD': 'US\$',
    'JPY': 'JP¥',
    'CAD': 'CA\$',
    'AUD': 'A\$',
    'CNY': 'CN¥',
  };
  if (lang == 'es') return code == 'USD' ? 'US\$' : code;
  if (code == 'AUD' && !const {'en', 'ru'}.contains(lang)) return 'AU\$';
  return prefixed[code] ?? code;
}

/// Minor units to the currency's own format; the currency says how many digits a minor unit is.
String money(num minor, String? currency, String lang) {
  final code = currency ?? 'USD';
  var f = NumberFormat.simpleCurrency(locale: lang, name: code);
  if (_shared.contains(f.currencySymbol) &&
      !(_bare[lang] ?? const <String>{}).contains(code)) {
    f = NumberFormat.currency(
      locale: lang,
      name: code,
      symbol: _icu(lang, code),
      decimalDigits: f.decimalDigits,
    );
  }
  return f.format(minor / math.pow(10, f.decimalDigits ?? 2));
}

/// claude-opus-5-5 reads Opus 5.5; anything else as it is.
String modelName(String id) => id
    .replaceFirst(RegExp(r'^claude-'), '')
    .replaceFirstMapped(
      RegExp(r'^([a-z])([a-z]*)-(\d+)-(\d+)$'),
      (m) => '${m[1]!.toUpperCase()}${m[2]} ${m[3]}.${m[4]}',
    );

DateTime _at(int ts) => DateTime.fromMillisecondsSinceEpoch(ts);

/// Weekday, day, month and time. Needs `initializeDateFormatting` once at startup.
String when(int ts, String lang) =>
    DateFormat.MMMEd(lang).add_Hm().format(_at(ts));

/// Day and month.
String shortTime(int ts, String lang) => DateFormat.MMMd(lang).format(_at(ts));

/// A week's Monday (a `YYYY-MM-DD` key), [plus] days on.
String weekDay(String key, String lang, [int plus = 0]) {
  final d = DateTime.parse('${key}T12:00:00');
  return shortTime(
    DateTime(d.year, d.month, d.day + plus, 12).millisecondsSinceEpoch,
    lang,
  );
}
