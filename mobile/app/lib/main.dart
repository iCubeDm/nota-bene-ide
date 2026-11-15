import 'dart:async';
import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'chat/chat_route.dart';
import 'chat/mermaid.dart';
import 'home.dart';
import 'hosts/host_link.dart';
import 'hosts/hosts_screen.dart';
import 'l10n/app_localizations.dart';
import 'lock/lock.dart';
import 'notify/background.dart';
import 'notify/platform.dart';
import 'notify/visible.dart';
import 'pairing/pair_flow.dart';
import 'pairing/scan_screen.dart';
import 'settings_screen.dart';
import 'store/hosts.dart';
import 'store/notified.dart';
import 'store/notify_choice.dart';
import 'store/seen.dart';
import 'store/lang_choice.dart';
import 'store/sizes.dart';
import 'store/voice_lang.dart';
import 'store/theme_choice.dart';
import 'store/vault.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // the usage dates are written in the app's language
  await initializeDateFormatting();
  // read before the first frame, so the app opens in the chosen theme
  final themes = await ThemeChoice.load(SecureVault());
  // and in the chosen language
  final langs = await LangChoice.load(SecureVault());
  // the language speech is transcribed in
  final voiceLang = await VoiceLang.load(SecureVault());
  // the text and interface sizes
  final sizes = await Sizes.load(SecureVault());
  // one hidden WebView for every diagram of the app, kept above the Navigator with the lock
  final mermaid = CachedMermaid(WebViewMermaid());
  runApp(
    NbApp(
      themes: themes,
      langs: langs,
      voiceLang: voiceLang,
      sizes: sizes,
      home: AppRoot(
        themes: themes,
        langs: langs,
        voiceLang: voiceLang,
        sizes: sizes,
      ),
      lock: (nav) => LockGate(
        authenticator: DeviceAuthenticator(),
        child: MermaidScope(renderer: mermaid, child: nav),
      ),
    ),
  );
}

/// Loads the phone key and the pairings, then the start screen.
class AppRoot extends StatefulWidget {
  const AppRoot({
    super.key,
    required this.themes,
    required this.langs,
    required this.voiceLang,
    required this.sizes,
  });

  final ThemeChoice themes;
  final LangChoice langs;
  final VoiceLang voiceLang;
  final Sizes sizes;

  @override
  State<AppRoot> createState() => _AppRootState();
}

class _AppRootState extends State<AppRoot> {
  final _visible = AppVisible();
  final _platform = ChannelBackground();

  /// The chats of tapped notifications: the one that started the app, then each tapped while it runs. Kept until the
  /// start screen listens (a launch is known before it is built).
  final _opened = StreamController<ChatPlace>();
  late final Future<
    ({
      Identity id,
      Hosts hosts,
      Seen seen,
      Links links,
      Background background,
      NotifyChoice notify,
    })
  >
  _load = () async {
    final v = SecureVault();
    final id = await Identity.load(v);
    final hosts = await Hosts.load(v);
    final seen = await Seen.load(v);
    final notified = await Notified.load(v);
    final notify = await NotifyChoice.load(v);
    final links = Links(hosts, connectChannel, id);
    seen.watch(hosts, links);
    hosts.addListener(() => notified.prune({for (final h in hosts.all) h.id}));
    final background = Background(
      links: links,
      seen: seen,
      notified: notified,
      visible: _visible,
      platform: _platform,
      strings: () => lookupAppLocalizations(
        widget.langs.locale ??
            resolveLocale(PlatformDispatcher.instance.locales),
      ),
      explain: _explain,
      enabled: notify.on,
    );
    _platform.opened.listen(_opened.add);
    unawaited(
      _platform.takeLaunch().then((p) {
        if (p != null) _opened.add(p);
      }),
    );
    return (
      id: id,
      hosts: hosts,
      seen: seen,
      links: links,
      background: background,
      notify: notify,
    );
  }();

  /// Why notifications are wanted, before Android's own question; true to go on to it.
  Future<bool> _explain() async {
    if (!mounted) return false;
    final t = AppLocalizations.of(context);
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(t.notifyAsk),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(t.notifyAskLater),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(t.notifyAskAllow),
          ),
        ],
      ),
    );
    return yes == true;
  }

  @override
  void dispose() {
    _load.then((d) {
      d.background.dispose();
      d.links.dispose();
    }, onError: (Object _) {});
    _visible.dispose();
    unawaited(_opened.close());
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
        seen: d.seen,
        links: d.links,
        onPair: pair,
        opened: _opened.stream,
        onSettings: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => SettingsScreen(
              identity: d.id,
              hosts: d.hosts,
              themes: widget.themes,
              langs: widget.langs,
              voiceLang: widget.voiceLang,
              sizes: widget.sizes,
              notify: NotifySettings(
                choice: d.notify,
                platform: _platform,
                apply: d.background.setEnabled,
              ),
              onPair: pair,
            ),
          ),
        ),
        chat: (hostId, w) {
          final link = d.links.of(hostId);
          return link == null
              ? Scaffold(appBar: AppBar(title: Text(folderOf(w.root))))
              : ChatRoute(
                  link: link,
                  port: w.port,
                  root: w.root,
                  seen: d.seen,
                  visible: _visible,
                );
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
  const NbApp({
    super.key,
    this.home,
    this.lock,
    this.themes,
    this.langs,
    this.voiceLang,
    this.sizes,
  });

  final Widget? home;

  /// Text and interface size; the phone's own without one.
  final Sizes? sizes;

  /// The phone's theme choice; Darcula without one (tests).
  final ThemeChoice? themes;

  /// The language picked in Settings; the phone's without one.
  final LangChoice? langs;

  /// The language voice is transcribed in; the app's without one.
  final VoiceLang? voiceLang;

  /// Wraps the whole Navigator (every route), when given.
  final Widget Function(Widget navigator)? lock;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([?themes, ?langs]),
    builder: (_, _) => _app(themes?.theme ?? NbTheme.darcula),
  );

  Widget _app(NbTheme theme) => MaterialApp(
    onGenerateTitle: (c) => AppLocalizations.of(c).appTitle,
    theme: theme.data,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    locale: langs?.locale,
    localeListResolutionCallback: (preferred, _) => resolveLocale(preferred),
    home: home ?? const Scaffold(),
    builder: (context, nav) {
      final child = nav ?? const SizedBox.shrink();
      return VoiceLangScope(
        choice: voiceLang,
        child: SizesScope(
          sizes: sizes,
          child: lock == null ? child : lock!(child),
        ),
      );
    },
  );
}
