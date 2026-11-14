// The periodic check without the app: Android's worker (CheckWorker.kt) starts an engine at [backgroundCheck] when no
// activity exists. It connects to every paired host, takes the first window list (or gives up after `wait`), notifies
// what is new, and closes everything.
import 'dart:async';
import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/widgets.dart';

import '../hosts/host_link.dart';
import '../l10n/app_localizations.dart';
import '../main.dart' show resolveLocale;
import '../pairing/pair_flow.dart' show ChannelFactory, connectChannel;
import '../store/hosts.dart';
import '../store/lang_choice.dart';
import '../store/notified.dart';
import '../store/notify_choice.dart';
import '../store/seen.dart';
import '../store/vault.dart';
import 'background.dart' show postEvent;
import 'events.dart';
import 'platform.dart';

@pragma('vm:entry-point')
Future<void> backgroundCheck() async {
  WidgetsFlutterBinding.ensureInitialized();
  final platform = ChannelBackground();
  try {
    final v = SecureVault();
    final lang = await LangChoice.load(v);
    await runCheck(
      vault: v,
      connect: connectChannel,
      platform: platform,
      strings: lookupAppLocalizations(
        lang.locale ?? resolveLocale(PlatformDispatcher.instance.locales),
      ),
    );
  } finally {
    await platform.done();
  }
}

Future<void> runCheck({
  required Vault vault,
  required ChannelFactory connect,
  required BackgroundPlatform platform,
  required AppLocalizations strings,
  Duration wait = const Duration(seconds: 20),
}) async {
  if (!(await NotifyChoice.load(vault)).on) return;
  final hosts = await Hosts.load(vault);
  if (hosts.all.isEmpty) return;
  final id = await Identity.load(vault);
  final seen = await Seen.load(vault);
  final notified = await Notified.load(vault);
  // one attempt per host: no backoff retries within a check
  final links = Links(
    hosts,
    connect,
    id,
    sleep: (_) => Completer<void>().future,
  );
  try {
    final settled = Completer<void>();
    void look() {
      if (links.all.every((l) => l.state != LinkState.connecting) &&
          !settled.isCompleted) {
        settled.complete();
      }
    }

    links.addListener(look);
    final timer = Timer(wait, () {
      if (!settled.isCompleted) settled.complete();
    });
    look();
    await settled.future;
    timer.cancel();
    links.removeListener(look);
    for (final l in links.all) {
      if (l.state != LinkState.online) continue;
      seen.observe(l.host.id, l.windows);
      for (final e in detect(l.host.id, l.windows, seen, notified)) {
        await postEvent(platform, e, strings);
      }
    }
    await seen.save();
    await notified.save();
  } finally {
    links.dispose();
  }
}
