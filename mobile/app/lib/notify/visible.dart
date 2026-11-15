// Whether the app is on screen, and which chat is: an open chat counts replies as seen only while someone can see it,
// and a notification is not posted for the chat in front of the user.
import 'package:flutter/widgets.dart';
import 'package:nb_channel/nb_channel.dart';

typedef ChatPlace = ({String hostId, int port, String root});

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

  void open(String hostId, int port, String root) {
    _chat = (hostId: hostId, port: port, root: root);
    notifyListeners();
  }

  void close(String hostId, int port, String root) {
    if (_chat != (hostId: hostId, port: port, root: root)) return;
    _chat = null;
    notifyListeners();
  }

  /// [w] of [hostId] is in front of the user.
  bool onScreen(String hostId, HostWindow w) =>
      _visible && _chat == (hostId: hostId, port: w.port, root: w.root);

  @override
  void dispose() {
    _life?.dispose();
    super.dispose();
  }
}
