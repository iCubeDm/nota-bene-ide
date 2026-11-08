// The phone as an ordinary tab of one window (/ws?tab=<id>), over a host link. The one-tab rule is the server's:
// occupied → Work here sends takeover; a 4001 means another tab took the window, and Work here takes it back. A
// window that went away (4904) is reopened when the host lists it again; a link that went down keeps the feed
// readable until the next replay replaces it.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../hosts/host_link.dart';
import 'feed.dart';

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

class WindowTab extends ChangeNotifier {
  WindowTab(
    this.link,
    this.port,
    this.root, {
    Future<void> Function(Duration)? retry,
  }) : _retry = retry ?? ((d) => Future<void>.delayed(d)) {
    link.addListener(_linkChanged);
    _linkChanged();
  }

  final HostLink link;
  final int port;
  final String root;
  final Future<void> Function(Duration) _retry;

  /// In memory only: a tab id kept on disk would let a second copy of the app steal the window.
  final String tabId = uuidV4();

  TabState _state = TabState.connecting;
  Feed feed = Feed();
  List<ModelOption> models = const [];
  String? model;
  AgentEffort? effort;
  num? protocol;
  Capabilities? capabilities;
  ServerEventStats? stats;

  final _refusals = StreamController<ServerEventSendRefused>.broadcast();
  final _errors = StreamController<ServerEventServerError>.broadcast();

  MuxStream? _stream;
  Channel? _on;
  bool _passive = false;
  bool _takeoverWanted = false;
  bool _reopening = false;
  bool _disposed = false;

  TabState get state => _state;

  /// A send the window refused (busy, switching): the composer keeps its text.
  Stream<ServerEventSendRefused> get refusals => _refusals.stream;

  Stream<ServerEventServerError> get errors => _errors.stream;

  bool get busy => feed.busy;

  void _set(TabState s) {
    if (_state == s) return;
    _state = s;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _linkChanged() {
    if (_disposed) return;
    final ch = link.channel;
    if (link.state != LinkState.online || ch == null) {
      if (_state != TabState.taken) _set(TabState.offline);
      return;
    }
    if (_state == TabState.gone && link.windows.any((w) => w.port == port)) {
      _open(ch);
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
    _on = ch;
    final s = _stream = ch.ws(
      port,
      '/ws?tab=$tabId${_passive ? '&passive=1' : ''}',
    );
    _set(TabState.connecting);
    s.messages.listen((m) {
      if (m.binary || !identical(s, _stream)) return;
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
      _set(TabState.gone);
      _linkChanged();
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
        _takeoverWanted = false;
        _passive = false;
        feed.apply(e);
        _set(TabState.open);
      case ServerEventOccupied():
        _passive = true;
        if (_takeoverWanted) {
          _raw(const ClientMessageTakeover());
        } else {
          _set(TabState.occupied);
        }
      case ServerEventHello(:final protocol, :final capabilities):
        this.protocol = protocol;
        this.capabilities = capabilities;
      case ServerEventModels(:final models):
        this.models = models;
      case ServerEventModel(:final model, :final effort):
        this.model = model;
        this.effort = effort;
      case ServerEventStats():
        stats = e;
      case ServerEventSendRefused():
        _refusals.add(e);
      case ServerEventServerError():
        _errors.add(e);
      default:
        feed.apply(e);
    }
    _notify();
  }

  void _raw(ClientMessage m) =>
      _stream?.send(utf8.encode(jsonEncode(m.toJson()))).catchError((_) {});

  /// Sends [m] when the tab owns the window; anything else would be dropped by the server anyway.
  void send(ClientMessage m) {
    if (_state == TabState.open) _raw(m);
  }

  bool _loadingEarlier = false;

  /// The next archived segment before the feed (the transcript before its compactions), as the desktop loads it.
  Future<void> loadEarlier() async {
    final ch = link.channel, session = feed.sessionId;
    if (_loadingEarlier || ch == null || session == null || feed.earlier == 0) {
      return;
    }
    _loadingEarlier = true;
    try {
      final segment = feed.earlier;
      final r = await ch.http(
        port,
        'GET',
        '/history?session=${Uri.encodeQueryComponent(session)}&before=${segment + 1}',
      );
      if (r.status != 200 || feed.sessionId != session) return;
      final j = jsonDecode(utf8.decode(r.body)) as Map<String, Object?>;
      feed.prepend(
        [
          for (final e in j['events'] as List)
            ServerEvent.fromJson((e as Map).cast<String, Object?>()),
        ],
        segment: (j['segment'] as num).toInt(),
        more: j['more'] == true,
      );
      _notify();
    } on Object {
      // the channel went or the page was not readable: the button stays for another try
    } finally {
      _loadingEarlier = false;
    }
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
    _refusals.close();
    _errors.close();
    super.dispose();
  }
}
