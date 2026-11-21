// The app's number and date formatters: ports of the desktop's (web/src/core/lib/format.ts, web/src/plugins/usage/UsageView.tsx),
// pinned by test/fixtures/usage/format.json, which the web side writes. [lang] is an app language code.
import 'dart:math' as math;

import 'package:intl/intl.dart';

/// A fraction as a whole percent: `33%`, `33 %`.
String percent(num v, String lang) =>
    NumberFormat.percentPattern(lang).format(v);

String pct(num a, num b, String lang) => percent(b > 0 ? a / b : 0, lang);

/// A part of the whole: a tiny one never reads as nothing.
String part(num a, num b, String lang) =>
    a / b < 0.01 ? '<${percent(0.01, lang)}' : pct(a, b, lang);

/// A count with the locale's grouping, as `toLocaleString` writes it. (`num` is a Dart type, hence the name.)
String fmtNum(num n, String lang) =>
    NumberFormat.decimalPattern(lang).format(n);

final _compact = <String, NumberFormat>{};

/// A large count the short way, in the language's own units (`1.5K`, `2,5 млн`, `250万`), as the desktop's one
/// formatter writes it (web/src/core/lib/format.ts, issue 469).
/// German has no short unit for thousands: such a count keeps every digit, grouped (`45.678`), as ICU writes it.
String fmtTokens(num n, String lang) {
  final s = (_compact[lang] ??= NumberFormat.compact(locale: lang)).format(n);
  return RegExp(r'^\d{5,}$').hasMatch(s) ? fmtNum(n, lang) : s;
}

/// ICU's short unit names, byte to terabyte.
const _bytes = {
  'en': ['B', 'kB', 'MB', 'GB', 'TB'], // CLDR's "3 byte" reads oddly
  'ru': ['Б', 'кБ', 'МБ', 'ГБ', 'ТБ'],
  'zh': ['B', 'kB', 'MB', 'GB', 'TB'],
  'es': ['B', 'kB', 'MB', 'GB', 'TB'],
  'pt': ['bytes', 'kB', 'MB', 'GB', 'TB'],
  'de': ['Byte', 'kB', 'MB', 'GB', 'TB'],
};

/// A size in the unit that reads best: `3 B`, `1.5 MB`, `2 ГБ` (999 999 bytes are 1 MB, not 1000 kB).
String byteSize(num n, String lang) {
  final units = _bytes[lang] ?? _bytes['en']!;
  var i = 0;
  while (i < units.length - 1 && n / math.pow(1000, i) >= 999.95) {
    i++;
  }
  final f = NumberFormat.decimalPattern(lang)..maximumFractionDigits = 1;
  final v = n / math.pow(1000, i);
  // ICU's German keeps a no-break space before one byte and before GB
  final space = lang == 'de' && (i == 3 || (i == 0 && v == 1)) ? '\u00a0' : ' ';
  return '${f.format(v)}$space${units[i]}';
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
