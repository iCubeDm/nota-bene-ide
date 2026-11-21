// A read repeated while its screen is up and the app is on screen (issue 573): a subagent's conversation and a shell's
// output are polled, not streamed, as on the desktop.
import 'dart:async';

import 'package:flutter/widgets.dart';

class Poll {
  /// Runs [read] at once and again after the delay it answers; null stops. A hidden app reads nothing, and reads at
  /// once when it is shown again.
  Poll(this.read) {
    _life = AppLifecycleListener(onShow: kick, onHide: _stop);
    kick();
  }

  final Future<Duration?> Function() read;
  late final AppLifecycleListener _life;
  Timer? _timer;
  var _run = 0;
  bool _over = false;

  /// Whether the app is on screen now (no state yet, as in a test, is on screen).
  static bool get _shown {
    final s = WidgetsBinding.instance.lifecycleState;
    return s == null || s == AppLifecycleState.resumed;
  }

  /// Reads now, whatever was waiting; the reads that follow are this one's.
  void kick() {
    _stop();
    if (_over || !_shown) return;
    final run = _run;
    read().then((next) {
      if (run != _run || _over || next == null) return;
      _timer = Timer(next, kick);
    });
  }

  void _stop() {
    _run++;
    _timer?.cancel();
    _timer = null;
  }

  void dispose() {
    _over = true;
    _stop();
    _life.dispose();
  }
}
