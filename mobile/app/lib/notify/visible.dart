// Whether the app is on screen, and which chat is: an open chat tells its window the person looks only while someone
// can see it (issue 174), and a notification is not posted for the chat in front of the user.
import 'package:flutter/widgets.dart';
import 'package:nb_channel/nb_channel.dart';

/// A chat by its host and its window's key ([HostWindowKey.key]).
typedef ChatPlace = ({String hostId, String window});

class AppVisible extends ChangeNotifier {
  AppVisible() : _visible = _now() {
    _life = AppLifecycleListener(
      onShow: () => visible = true,
      onHide: () => visible = false,
    );
  }

  /// Without the lifecycle: tests set [visible] themselves.
  @visibleForTesting
  AppVisible.test({bool visible = true}) : _visible = visible;

  AppLifecycleListener? _life;

  static bool _now() {
    final s = WidgetsBinding.instance.lifecycleState;
    return s == null || s == AppLifecycleState.resumed;
  }

  bool _visible;
  bool get visible => _visible;
  set visible(bool v) {
    if (v == _visible) return;
    _visible = v;
    notifyListeners();
  }

  ChatPlace? _chat;

  /// The chat route in use (a screen pushed over it keeps it: its tab is still the one in use).
  ChatPlace? get chat => _chat;

  void open(String hostId, String window) {
    _chat = (hostId: hostId, window: window);
    notifyListeners();
  }

  void close(String hostId, String window) {
    if (_chat != (hostId: hostId, window: window)) return;
    _chat = null;
    notifyListeners();
  }

  /// [w] of [hostId] is in front of the user.
  bool onScreen(String hostId, HostWindow w) =>
      _visible && _chat == (hostId: hostId, window: w.key);

  @override
  void dispose() {
    _life?.dispose();
    super.dispose();
  }
}
