// The phone as an ordinary tab of one window (/ws?tab=<id>), over a host link. The one-tab rule is the server's:
// occupied → Work here sends takeover; a 4001 means another tab took the window, and Work here takes it back. A
// window that went away (4904) is reopened when the host lists it again; a link that went down keeps the feed
// readable until the next replay replaces it. What the window says goes to [AgentConnection.onEvent] (issue 511).
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';
import 'package:nb_protocol/nb_protocol.dart' as nb show has;

import '../hosts/host_link.dart';

enum TabState { connecting, open, occupied, taken, gone, offline }

const takenOverCode = 4001;

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
       _port = w.port,
       _agent = w.agent,
       _retry = retry ?? ((d) => Future<void>.delayed(d));

  final HostLink link;

  /// Each event the window sends but `occupied`, the connection's own; a replay's before the tab is open.
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
  int _port;
  String? _agent;

  /// The window as its host lists it now; null while it is not listed. The one on the tab's port first: a second
  /// window of the folder and agent on a lower port takes the bare id (issue 511), and the chat must not move to it.
  /// By key only once that port is gone (a restart on another port). The folder and its agent too: a host before ids
  /// keys by port, and one server may hold the folder under two agents on that port (epic 383).
  HostWindow? get window {
    final same = link.windows.where(
      (w) => w.root == root && w.provider == provider,
    );
    final w =
        same.where((w) => w.port == _port).firstOrNull ??
        same.where((w) => w.key == _key).firstOrNull;
    if (w != null) {
      _port = w.port;
      _key = w.key;
      _agent = w.agent;
    }
    return w;
  }

  /// Transport only: where the window's streams open (the port it was last listed on).
  int get port {
    window;
    return _port;
  }

  /// A path of the window's streams, as it was last listed: one of a server's other agents (epic 383) answers under
  /// `/a/<agent>`, and a folder that moved into a server keeps its chat there.
  String at(String path) {
    window;
    return _agent == null ? path : '/a/$_agent$path';
  }

  final Future<void> Function(Duration) _retry;

  /// In memory only: a tab id kept on disk would let a second copy of the app steal the window.
  final String tabId = uuidV4();

  /// The window's protocol, from its hello.
  num? protocol;

  /// Whether the window speaks [f].
  bool has(Feature f) => nb.has(protocol, f);

  /// The window's own requests through its channel; null while the host is offline.
  WindowHttp? get http {
    final ch = link.channel;
    if (ch == null) return null;
    return (method, path, {headers, body}) =>
        ch.http(port, method, at(path), headers: headers, body: body);
  }

  TabState _state = TabState.connecting;
  MuxStream? _stream;
  Channel? _on;
  bool _passive = false;
  bool _takeoverWanted = false;
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
      if (_state != TabState.taken) _set(TabState.offline);
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
    if (!identical(ch, _on) &&
        _state != TabState.taken &&
        _state != TabState.gone) {
      _open(ch);
    }
  }

  void _open(Channel ch) {
    _stream?.close(1000);
    onSocket?.call();
    _on = ch;
    final s = _stream = ch.ws(
      port,
      // held=1 (issue 499): the phone knows `send-held`, so its messages may wait behind a pending restart or compaction
      at('/ws?tab=$tabId&held=1${_passive ? '&passive=1' : ''}'),
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
    if (code == takenOverCode) {
      _passive = true;
      _set(TabState.taken);
      return;
    }
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
      case ServerEventOccupied():
        _passive = true;
        if (_takeoverWanted) {
          _raw(const ClientMessageTakeover());
        } else {
          _set(TabState.occupied);
        }
      case ServerEventReplay():
        _takeoverWanted = false;
        _passive = false;
        onEvent(e);
        _set(TabState.open);
        onOpen?.call();
      case ServerEventHello(:final protocol):
        this.protocol = protocol;
        onEvent(e);
      default:
        onEvent(e);
    }
  }

  bool _raw(ClientMessage m) {
    final s = _stream;
    if (s == null || s.isClosed) return false;
    s.send(utf8.encode(jsonEncode(m.toJson()))).catchError((_) {});
    return true;
  }

  /// Sends [m] when the tab owns the window (anything else would be dropped by the server); false when it did not go.
  bool send(ClientMessage m) => _state == TabState.open && _raw(m);

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

  /// Work here: from occupied, at once; from taken, on a new socket whose occupied is answered with takeover.
  void takeOver() {
    _takeoverWanted = true;
    if (_state == TabState.occupied) {
      _raw(const ClientMessageTakeover());
    } else if (_state == TabState.taken) {
      final ch = link.channel;
      if (ch != null && link.state == LinkState.online) _open(ch);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    link.removeListener(_linkChanged);
    _stream?.close(1000);
    super.dispose();
  }
}
