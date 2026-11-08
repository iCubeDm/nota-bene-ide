import 'package:flutter/material.dart';

import 'home.dart';
import 'hosts/host_link.dart';
import 'hosts/hosts_screen.dart';
import 'l10n/app_localizations.dart';
import 'lock/lock.dart';
import 'pairing/pair_flow.dart';
import 'pairing/scan_screen.dart';
import 'store/hosts.dart';
import 'store/vault.dart';
import 'theme.dart';

void main() => runApp(
  NbApp(
    home: const AppRoot(),
    lock: (nav) => LockGate(authenticator: DeviceAuthenticator(), child: nav),
  ),
);

/// Loads the phone key and the pairings, then the start screen.
class AppRoot extends StatefulWidget {
  const AppRoot({super.key});

  @override
  State<AppRoot> createState() => _AppRootState();
}

class _AppRootState extends State<AppRoot> {
  late final Future<({Identity id, Hosts hosts, Links links})> _load =
      () async {
        final v = SecureVault();
        final id = await Identity.load(v);
        final hosts = await Hosts.load(v);
        return (id: id, hosts: hosts, links: Links(hosts, connectChannel, id));
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
      return Home(
        hosts: d.hosts,
        links: d.links,
        onPair: () => Navigator.of(context).push(
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
        ),
        chat: (hostId, w) => Scaffold(
          appBar: AppBar(title: Text(folderOf(w.root))),
          body: Center(child: Text(AppLocalizations.of(context).chatSoon)),
        ),
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
  const NbApp({super.key, this.home, this.lock});

  final Widget? home;

  /// Wraps the whole Navigator (every route), when given.
  final Widget Function(Widget navigator)? lock;

  @override
  Widget build(BuildContext context) => MaterialApp(
    onGenerateTitle: (c) => AppLocalizations.of(c).appTitle,
    theme: darcula(),
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    localeListResolutionCallback: (preferred, _) => resolveLocale(preferred),
    home: home ?? const Scaffold(),
    builder: lock == null
        ? null
        : (context, nav) => lock!(nav ?? const SizedBox.shrink()),
  );
}
