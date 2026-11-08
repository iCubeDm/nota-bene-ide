import 'package:flutter/material.dart';

import 'l10n/app_localizations.dart';
import 'theme.dart';

void main() => runApp(const NbApp());

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

class NbApp extends StatelessWidget {
  const NbApp({super.key, this.home});

  final Widget? home;

  @override
  Widget build(BuildContext context) => MaterialApp(
    onGenerateTitle: (c) => AppLocalizations.of(c).appTitle,
    theme: darcula(),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    localeListResolutionCallback: (preferred, _) => resolveLocale(preferred),
    home: home ?? const Scaffold(),
  );
}
