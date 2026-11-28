// The phone as one more client of a window (/ws), over a host link: every client of a window is live at once (issue
// 174). A window that went away (4904) is reopened when the host lists it again; a link that went down keeps the feed
// readable until the next replay replaces it. What the window says goes to [AgentConnection.onEvent] (issue 511).
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';
import 'package:nb_protocol/nb_protocol.dart' as nb show has;

import '../hosts/host_link.dart';

enum TabState { connecting, open, gone, offline, old }

/// The app's floor, protocol 41 (the shared read state, issue 174): everything up to it is used without asking, and a
/// window that lacks it is not opened ([TabState.old]).
const floor = Feature.looking;

String uuidV4() {
  final r = Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

class AgentConnection extends ChangeNotifier {
  AgentConnection(
    this.link,
    HostWindow w, {
    required this.onEvent,
    this.onSocket,
    this.onOpen,
    Future<void> Function(Duration)? retry,
  }) : _key = w.key,
       root = w.root,
       provider = w.provider,
       _address = w.address,
       _retry = retry ?? ((d) => Future<void>.delayed(d));

  final HostLink link;

  /// Each event the window sends; a replay's before the tab is open.
  final void Function(ServerEvent) onEvent;

  /// A new socket is about to open: what the last one said is stale.
  final void Function()? onSocket;

  /// The window takes messages (after its replay): what waited for it may go.
  final void Function()? onOpen;

  /// The window's key on its host ([HostWindowKey.key]) as it was last listed.
  String get key => _key;
  String _key;
  final String root;

  /// The agent the window runs: a server may hold the folder under two (epic 383), on one port.
  final AgentProvider provider;
  AgentAddress _address;

  /// The window as its host lists it now; null while it is not listed. The one on the tab's port first: a second
  /// window of the folder and agent on a lower port takes the bare id (issue 511), and the chat must not move to it.
  /// By key only once that port is gone (a restart on another port). The folder and its agent too: a host before ids
  /// keys by port, and one server may hold the folder under two agents on that port (epic 383).
  HostWindow? get window {
    final same = link.windows.where(
      (w) => w.root == root && w.provider == provider,
    );
    final w =
        same.where((w) => w.port == _address.port).firstOrNull ??
        same.where((w) => w.key == _key).firstOrNull;
    if (w != null) {
      _address = w.address;
      _key = w.key;
    }
    return w;
  }

  /// Transport only: where the window's streams open, as it was last listed (a restart moves its port, and a folder
  /// that moved into a server keeps its chat there, under that server's agent).
  AgentAddress get address {
    window;
    return _address;
  }

  final Future<void> Function(Duration) _retry;

  /// The window's protocol, from its hello.
  num? protocol;

  /// Whether the window speaks [f].
  bool has(Feature f) => nb.has(protocol, f);

  /// The window's own requests through its channel; null while the host is offline.
  WindowHttp? get http {
    final ch = link.channel;
    if (ch == null) return null;
    return (method, path, {headers, body}) {
      final a = address;
      return ch.http(a.port, method, a.at(path), headers: headers, body: body);
    };
  }

  TabState _state = TabState.connecting;
  MuxStream? _stream;
  Channel? _on;
  bool _reopening = false;
  List<HostWindow>? _goneList;
  bool _started = false;
  bool _disposed = false;

  TabState get state => _state;

  void _set(TabState s) {
    if (_state == s) return;
    _state = s;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Follows the link from now on: opens the window's socket once the host is online.
  void start() {
    if (_started) return;
    _started = true;
    link.addListener(_linkChanged);
    _linkChanged();
  }

  void _linkChanged() {
    if (_disposed) return;
    final ch = link.channel;
    if (link.state != LinkState.online || ch == null) {
      _set(TabState.offline);
      return;
    }
    if (_state == TabState.gone) {
      // only a list the host sent after the close: the one from before still names the window that just went
      final fresh = !identical(link.windows, _goneList);
      if (fresh && window != null) {
        _open(ch);
      }
      return;
    }
    if (!identical(ch, _on)) _open(ch);
  }

  void _open(Channel ch) {
    _stream?.close(1000);
    onSocket?.call();
    _on = ch;
    final a = address;
    final s = _stream = ch.ws(
      a.port,
      // held=1 (issue 499): the phone knows `send-held`, so its messages may wait behind a pending restart or compaction
      a.at('/ws?held=1'),
    );
    _set(TabState.connecting);
    s.messages.listen((m) {
      if (m.binary || !identical(s, _stream) || _disposed) return;
      final Object? j;
      try {
        j = jsonDecode(utf8.decode(m.data));
      } on FormatException {
        return;
      }
      if (j is Map) _event(ServerEvent.fromJson(j.cast<String, Object?>()));
    });
    s.closed.then((c) {
      if (!identical(s, _stream) || _disposed) return;
      _stream = null;
      _closed(c.code);
    });
  }

  void _closed(int code) {
    if (code == unknownWindow) {
      _goneList = link.windows;
      _set(TabState.gone);
      return;
    }
    if (link.state != LinkState.online ||
        link.channel == null ||
        link.channel!.isClosed) {
      _set(TabState.offline);
      return;
    }
    // the window's socket closed under a live link (a restart, a refused socket): try again in a second, as the web does
    _set(TabState.connecting);
    if (_reopening) return;
    _reopening = true;
    _retry(const Duration(seconds: 1)).then((_) {
      _reopening = false;
      final ch = link.channel;
      if (!_disposed &&
          _stream == null &&
          ch != null &&
          _state == TabState.connecting) {
        _open(ch);
      }
    });
  }

  void _event(ServerEvent e) {
    switch (e) {
      case ServerEventReplay():
        onEvent(e);
        _set(TabState.open);
        onOpen?.call();
      case ServerEventHello(:final protocol):
        this.protocol = protocol;
        if (!has(floor)) {
          // not ours any more: its close must not start a retry
          final s = _stream;
          _stream = null;
          s?.close(1000);
          _set(TabState.old);
          return;
        }
        onEvent(e);
      default:
        onEvent(e);
    }
  }

  /// Sends [m] once the window is open (after its replay); false when it did not go.
  bool send(ClientMessage m) {
    final s = _stream;
    if (_state != TabState.open || s == null || s.isClosed) return false;
    s.send(utf8.encode(jsonEncode(m.toJson()))).catchError((_) {});
    return true;
  }

  /// Opens the window's socket again by hand, for a window that went and has not come back on its own. The phone cannot
  /// start a window (the protocol has no such request), so this is only another try at reaching it.
  void reopen() {
    final ch = link.channel;
    if (_state != TabState.gone ||
        ch == null ||
        link.state != LinkState.online) {
      return;
    }
    _open(ch);
  }

  @override
  void dispose() {
    _disposed = true;
    link.removeListener(_linkChanged);
    _stream?.close(1000);
    super.dispose();
  }
}
