import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'chat/chat_route.dart';
import 'chat/mermaid.dart';
import 'home.dart';
import 'hosts/host_link.dart';
import 'hosts/hosts_screen.dart';
import 'l10n/app_localizations.dart';
import 'lock/lock.dart';
import 'pairing/pair_flow.dart';
import 'pairing/scan_screen.dart';
import 'settings_screen.dart';
import 'store/hosts.dart';
import 'store/seen.dart';
import 'store/theme_choice.dart';
import 'store/vault.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // the usage dates are written in the app's language
  await initializeDateFormatting();
  // read before the first frame, so the app opens in the chosen theme
  final themes = await ThemeChoice.load(SecureVault());
  // one hidden WebView for every diagram of the app, kept above the Navigator with the lock
  final mermaid = CachedMermaid(WebViewMermaid());
  runApp(
    NbApp(
      themes: themes,
      home: AppRoot(themes: themes),
      lock: (nav) => LockGate(
        authenticator: DeviceAuthenticator(),
        child: MermaidScope(renderer: mermaid, child: nav),
      ),
    ),
  );
}

/// Loads the phone key and the pairings, then the start screen.
class AppRoot extends StatefulWidget {
  const AppRoot({super.key, required this.themes});

  final ThemeChoice themes;

  @override
  State<AppRoot> createState() => _AppRootState();
}

class _AppRootState extends State<AppRoot> {
  late final Future<({Identity id, Hosts hosts, Seen seen, Links links})>
  _load = () async {
    final v = SecureVault();
    final id = await Identity.load(v);
    final hosts = await Hosts.load(v);
    final seen = await Seen.load(v);
    return (
      id: id,
      hosts: hosts,
      seen: seen,
      links: Links(hosts, connectChannel, id),
    );
  }();

  @override
  void dispose() {
    _load.then((d) => d.links.dispose(), onError: (Object _) {});
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FutureBuilder(
    future: _load,
    builder: (context, snap) {
      if (snap.hasError) {
        return Scaffold(
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                AppLocalizations.of(context).storeUnreadable,
                textAlign: TextAlign.center,
              ),
            ),
          ),
        );
      }
      final d = snap.data;
      if (d == null) {
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      }
      void pair() => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => PairScreen(
            flow: PairFlow(
              connectChannel,
              d.id,
              d.hosts,
              pause: d.links.pauseHost,
              resume: d.links.resumeHost,
            ),
          ),
        ),
      );
      return Home(
        hosts: d.hosts,
        links: d.links,
        onPair: pair,
        onSettings: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => SettingsScreen(
              identity: d.id,
              hosts: d.hosts,
              themes: widget.themes,
              onPair: pair,
            ),
          ),
        ),
        chat: (hostId, w) {
          final link = d.links.of(hostId);
          return link == null
              ? Scaffold(appBar: AppBar(title: Text(folderOf(w.root))))
              : ChatRoute(link: link, port: w.port, root: w.root, seen: d.seen);
        },
      );
    },
  );
}

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
  const NbApp({super.key, this.home, this.lock, this.themes});

  final Widget? home;

  /// The phone's theme choice; Darcula without one (tests).
  final ThemeChoice? themes;

  /// Wraps the whole Navigator (every route), when given.
  final Widget Function(Widget navigator)? lock;

  @override
  Widget build(BuildContext context) => themes == null
      ? _app(NbTheme.darcula)
      : ListenableBuilder(
          listenable: themes!,
          builder: (_, _) => _app(themes!.theme),
        );

  Widget _app(NbTheme theme) => MaterialApp(
    onGenerateTitle: (c) => AppLocalizations.of(c).appTitle,
    theme: theme.data,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    localeListResolutionCallback: (preferred, _) => resolveLocale(preferred),
    home: home ?? const Scaffold(),
    builder: lock == null
        ? null
        : (context, nav) => lock!(nav ?? const SizedBox.shrink()),
  );
}
