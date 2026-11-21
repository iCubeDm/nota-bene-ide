// When the host links run (issue 565): while the app is on screen, and while something holds them (the background
// service, a periodic check). A hidden app that nothing holds drops them after [LinkLife.hiddenPause]; the last hold
// let go while hidden drops them at once. Made by the app root beside the links; the notifications only hold.
import 'dart:async';

import '../notify/visible.dart';
import 'host_link.dart';

class LinkLife {
  LinkLife(
    this.links,
    this.visible, {
    this.hiddenPause = const Duration(minutes: 10),
  }) : _wasVisible = visible.visible {
    visible.addListener(_shown);
  }

  final Links links;
  final AppVisible visible;
  final Duration hiddenPause;

  final _holds = <Object>{};
  Timer? _pause;
  bool _wasVisible;

  /// Dropped by this, not yet taken up again.
  bool _paused = false;

  /// [who] needs the links whether the app is seen or not: they run until it lets go.
  void hold(Object who) {
    _holds.add(who);
    _pause?.cancel();
    _pause = null;
    if (_paused) _resume();
  }

  void release(Object who) {
    if (_holds.remove(who) && _holds.isEmpty && !visible.visible) _drop();
  }

  void _shown() {
    final now = visible.visible;
    if (now == _wasVisible) return;
    _wasVisible = now;
    if (now) {
      _pause?.cancel();
      _pause = null;
      _resume();
    } else if (_holds.isEmpty) {
      _pause ??= Timer(hiddenPause, () {
        _pause = null;
        if (_holds.isEmpty && !visible.visible) _drop();
      });
    }
  }

  void _drop() {
    _paused = true;
    links.pause();
  }

  void _resume() {
    _paused = false;
    links.resume();
  }

  void dispose() {
    visible.removeListener(_shown);
    _pause?.cancel();
  }
}
