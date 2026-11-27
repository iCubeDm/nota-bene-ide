// Keeps the relay links while agents work and tells the user what they did: a foreground service holds the process (and
// the links, through [LinkLife]) while some window is busy or waits for the user, and for [Background.linger] after;
// every window list that arrives is turned into notifications (events.dart). Without the service a hidden app drops
// its links after [LinkLife.hiddenPause]; the periodic check then asks [Background.check], which holds them meanwhile.
import 'dart:async';

import 'package:nb_channel/nb_channel.dart';

import '../hosts/host_link.dart';
import '../hosts/link_life.dart';
import '../l10n/app_localizations.dart';
import '../store/notified.dart';
import 'events.dart';
import 'platform.dart';
import 'settle.dart';
import 'visible.dart';

/// Posts [e] as a notification: the project as title, the reply's start (or "waits for you") as text; the lock screen
/// shows only the public title. A [ReadEvent] takes the session's notification back.
Future<void> postEvent(
  BackgroundPlatform platform,
  AgentEvent e,
  AppLocalizations s,
) => switch (e) {
  ReadEvent() => platform.cancel(e.key),
  ReplyEvent(:final text) => platform.notify(
    tag: e.key,
    title: e.project,
    text: text,
    publicTitle: s.notifyReplyPublic(e.project),
    hostId: e.hostId,
    window: e.w.key,
    channelName: s.notifyChannelEvents,
  ),
  WaitEvent() => platform.notify(
    tag: e.key,
    title: e.project,
    text: s.notifyWaitingText,
    publicTitle: s.notifyWaitingPublic(e.project),
    hostId: e.hostId,
    window: e.w.key,
    channelName: s.notifyChannelEvents,
  ),
};

class Background {
  Background({
    required this.links,
    required this.life,
    required this.notified,
    required this.visible,
    required this.platform,
    required this.strings,
    required this.explain,
    this.linger = const Duration(minutes: 5),
    bool enabled = true,
  }) : _enabled = enabled {
    links.addListener(_changed);
    visible.addListener(_shown);
    platform.onCheck(check);
    unawaited(_init());
  }

  final Links links;

  /// What keeps the links: the service and a check hold them.
  final LinkLife life;
  final Notified notified;
  final AppVisible visible;
  final BackgroundPlatform platform;
  final AppLocalizations Function() strings;

  /// Says why notifications are wanted before Android asks; false: the user declined here.
  final Future<bool> Function() explain;

  final Duration linger;

  bool _enabled;
  bool _disposed = false;

  /// Notifications allowed by Android (known after the first [BackgroundPlatform.permission]).
  bool _granted = false;

  /// Asked once and refused: neither asked again nor started.
  bool _refused = false;
  bool _starting = false;
  bool _serviceOn = false;
  bool get serviceOn => _serviceOn;
  String? _serviceText;
  Timer? _quiet;
  bool _wasVisible = true;

  /// What a check holds the links by.
  final _checking = Object();

  Future<void> _init() async {
    _wasVisible = visible.visible;
    await _recheck();
  }

  /// Asks Android again: notifications may have been allowed or blocked in its settings meanwhile.
  Future<void> _recheck() async {
    final p = await platform.permission();
    if (_disposed) return;
    _granted = p == 'granted';
    _refused = p == 'denied';
    await _schedule();
    _changed();
  }

  /// Whether a host was paired when the check was last scheduled.
  bool? _hadHosts;

  Future<void> _schedule() {
    _hadHosts = links.all.isNotEmpty;
    return platform.schedule(_enabled && _granted && _hadHosts!);
  }

  Future<void> setEnabled(bool on) async {
    _enabled = on;
    if (!on) {
      await _stop();
      await _schedule();
    } else {
      await _recheck();
    }
  }

  void _changed() {
    if (_disposed) return;
    // a first host paired, or the last one forgotten
    if (_hadHosts != null && _hadHosts != links.all.isNotEmpty) {
      unawaited(_schedule());
    }
    final online = [
      for (final l in links.all)
        if (l.state == LinkState.online) l,
    ];
    if (_enabled && _granted) {
      final s = strings();
      for (final l in online) {
        for (final e in detect(
          l.host.id,
          l.windows,
          notified,
          onScreen: visible.onScreen,
        )) {
          unawaited(postEvent(platform, e, s));
        }
      }
    }
    final working = [
      for (final l in online)
        for (final w in l.windows)
          if (w.busy == true || w.pending == true) w,
    ];
    if (working.isEmpty) {
      if (_serviceOn) _quiet ??= Timer(linger, () => unawaited(_stop()));
      return;
    }
    _quiet?.cancel();
    _quiet = null;
    final s = strings();
    final text = working.any((w) => w.pending == true)
        ? s.notifyServiceWaiting
        : s.notifyServiceWorking(working.length);
    if (_serviceOn) {
      if (text != _serviceText) {
        _serviceText = text;
        unawaited(platform.updateService('Nota Bene', text));
      }
    } else if (_enabled && visible.visible) {
      unawaited(_start(text));
    }
  }

  Future<void> _start(String text) async {
    if (_starting || _refused) return;
    _starting = true;
    try {
      if (!_granted) {
        final p = await platform.permission();
        if (p == 'ask' && await explain()) {
          _granted = await platform.requestPermission();
        } else {
          _granted = p == 'granted';
        }
        if (!_granted) {
          _refused = true;
          return;
        }
        await _schedule();
      }
      if (_disposed || !_enabled) return;
      await platform.startService(
        'Nota Bene',
        text,
        strings().notifyChannelService,
      );
      _serviceOn = true;
      _serviceText = text;
      life.hold(this);
    } on Object {
      // Android refused the service (the app went to the background meanwhile): the links behave as without it
    } finally {
      _starting = false;
    }
  }

  Future<void> _stop() async {
    _quiet?.cancel();
    _quiet = null;
    if (!_serviceOn) return;
    _serviceOn = false;
    _serviceText = null;
    await platform.stopService();
    life.release(this);
  }

  void _shown() {
    if (_disposed) return;
    final now = visible.visible;
    if (now != _wasVisible) {
      _wasVisible = now;
      if (now) {
        unawaited(notified.reload());
        unawaited(_recheck());
      }
    }
    // the chat in front of the user: its notification has been read
    final chat = visible.chat;
    if (now && chat != null) {
      final w = links
          .of(chat.hostId)
          ?.windows
          .where((w) => w.key == chat.window)
          .firstOrNull;
      if (w?.session != null) {
        unawaited(platform.cancel('${chat.hostId} ${w!.session}'));
      }
    }
  }

  /// The periodic check, while the app runs: links that are paused connect for up to [wait], their window lists are
  /// notified as they arrive, and they pause again unless the app is on screen or the service runs.
  Future<void> check({Duration wait = const Duration(seconds: 20)}) async {
    if (_disposed || visible.visible || _serviceOn) return;
    life.hold(_checking);
    try {
      await linksSettled(links, wait);
      _changed();
    } finally {
      life.release(_checking);
    }
  }

  void dispose() {
    _disposed = true;
    links.removeListener(_changed);
    visible.removeListener(_shown);
    _quiet?.cancel();
  }
}
