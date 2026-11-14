// Keeps the relay links while agents work and tells the user what they did: a foreground service holds the process (and
// the links) while some window is busy or waits for the user, and for [Background.linger] after; every window list
// that arrives is turned into notifications (events.dart). Without the service a hidden app drops its links after
// [Background.hiddenPause], as before; the periodic check then asks [Background.check].
import 'dart:async';

import '../hosts/host_link.dart';
import '../l10n/app_localizations.dart';
import '../store/notified.dart';
import '../store/seen.dart';
import 'events.dart';
import 'platform.dart';
import 'visible.dart';

class Background {
  Background({
    required this.links,
    required this.seen,
    required this.notified,
    required this.visible,
    required this.platform,
    required this.strings,
    required this.explain,
    this.linger = const Duration(minutes: 5),
    this.hiddenPause = const Duration(minutes: 10),
    bool enabled = true,
  }) : _enabled = enabled {
    links.addListener(_changed);
    visible.addListener(_shown);
    platform.onCheck(check);
    unawaited(_init());
  }

  final Links links;
  final Seen seen;
  final Notified notified;
  final AppVisible visible;
  final BackgroundPlatform platform;
  final AppLocalizations Function() strings;

  /// Says why notifications are wanted before Android asks; false: the user declined here.
  final Future<bool> Function() explain;

  final Duration linger, hiddenPause;

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
  Timer? _quiet, _pause;
  bool _wasVisible = true;

  Future<void> _init() async {
    final p = await platform.permission();
    _granted = p == 'granted';
    _refused = p == 'denied';
    _wasVisible = visible.visible;
    await _schedule();
    _changed();
  }

  Future<void> _schedule() =>
      platform.schedule(_enabled && _granted && links.all.isNotEmpty);

  Future<void> setEnabled(bool on) async {
    _enabled = on;
    if (!on) await _stop();
    await _schedule();
    if (on) _changed();
  }

  void _changed() {
    if (_disposed) return;
    final online = [
      for (final l in links.all)
        if (l.state == LinkState.online) l,
    ];
    if (_enabled && _granted) {
      final s = strings();
      for (final l in online) {
        seen.observe(l.host.id, l.windows);
        for (final e in detect(
          l.host.id,
          l.windows,
          seen,
          notified,
          onScreen: visible.onScreen,
        )) {
          unawaited(_post(e, s));
        }
      }
    }
    final working = [
      for (final l in online)
        for (final w in l.windows)
          if (w.busy || w.pending) w,
    ];
    if (working.isEmpty) {
      if (_serviceOn) _quiet ??= Timer(linger, () => unawaited(_stop()));
      return;
    }
    _quiet?.cancel();
    _quiet = null;
    final s = strings();
    final text = working.any((w) => w.pending)
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

  Future<void> _post(AgentEvent e, AppLocalizations s) => platform.notify(
    tag: e.key,
    title: e.project,
    text: switch (e) {
      ReplyEvent(:final text) => text,
      WaitEvent() => s.notifyWaitingText,
    },
    publicTitle: switch (e) {
      ReplyEvent() => s.notifyReplyPublic(e.project),
      WaitEvent() => s.notifyWaitingPublic(e.project),
    },
    hostId: e.hostId,
    port: e.port,
    root: e.root,
    channelName: s.notifyChannelEvents,
  );

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
      _pause?.cancel();
      _pause = null;
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
    if (!visible.visible) links.pause();
  }

  void _shown() {
    if (_disposed) return;
    final now = visible.visible;
    if (now != _wasVisible) {
      _wasVisible = now;
      if (now) {
        _pause?.cancel();
        _pause = null;
        links.resume();
        unawaited(seen.reload());
        unawaited(notified.reload());
      } else if (!_serviceOn) {
        _pause ??= Timer(hiddenPause, () {
          _pause = null;
          if (!_serviceOn && !visible.visible) links.pause();
        });
      }
    }
    // the chat in front of the user: its notification has been read
    final chat = visible.chat;
    if (now && chat != null) {
      final w = links
          .of(chat.hostId)
          ?.windows
          .where((w) => w.port == chat.port && w.root == chat.root)
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
    _pause?.cancel();
    _pause = null;
    links.resume();
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
    _changed();
    if (!visible.visible && !_serviceOn) links.pause();
  }

  void dispose() {
    _disposed = true;
    links.removeListener(_changed);
    visible.removeListener(_shown);
    _quiet?.cancel();
    _pause?.cancel();
  }
}
