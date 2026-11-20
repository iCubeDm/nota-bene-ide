import 'dart:ui' show Locale;

/// The phone's language when Nota Bene has it (UI_LANGS: zh is zh-CN, pt is pt-BR), otherwise English.
Locale resolveLocale(List<Locale>? preferred) {
  for (final l in preferred ?? const <Locale>[]) {
    switch (l.languageCode) {
      case 'en' || 'ru' || 'zh' || 'es' || 'pt' || 'de':
        return Locale(l.languageCode);
    }
  }
  return const Locale('en');
}
