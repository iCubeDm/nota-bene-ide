// One channel per paired host, kept up with backoff (1 s doubling to 30 s, ±20 %), the way the connector keeps its
// relay connection. A 4403 from the relay means the host no longer lists this phone: the link stops there.
import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart';

import '../pairing/pair_flow.dart';
import '../store/hosts.dart';

enum LinkState { connecting, online, offline, unpaired }

class HostLink extends ChangeNotifier {
  HostLink(
    this.host,
    this._connect,
    this._identity, {
    this.minBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 30),
    DateTime Function()? clock,
    double Function()? jitter,
    Future<void> Function(Duration)? sleep,
  }) : _clock = clock ?? DateTime.now,
       _jitter = jitter ?? Random().nextDouble,
       _sleep = sleep ?? ((d) => Future<void>.delayed(d));

  final PairedHost host;
  final ChannelFactory _connect;
  final Identity _identity;
  final Duration minBackoff, maxBackoff;
  final DateTime Function() _clock;
  final double Function() _jitter;
  final Future<void> Function(Duration) _sleep;

  LinkState _state = LinkState.connecting;
  DateTime? _lastSeen;
  List<HostWindow> _windows = const [];
  Channel? _channel;
  int _attempt = 0;
  int _gen = 0;
  bool _running = false;
  bool _disposed = false;

  LinkState get state => _state;

  /// When the channel last went down (null while it never was up).
  DateTime? get lastSeen => _lastSeen;

  /// The windows the host listed last; kept while offline.
  List<HostWindow> get windows => _windows;

  Channel? get channel => _channel;

  bool get running => _running;

  void _set(LinkState s) {
    if (_state == s) return;
    _state = s;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void start() {
    if (_running) return;
    _running = true;
    unawaited(_loop(++_gen));
  }

  void stop() {
    _running = false;
    _gen++;
    final ch = _channel;
    _channel = null;
    unawaited(ch?.close());
  }

  @override
  void dispose() {
    stop();
    _disposed = true;
    super.dispose();
  }

  Future<void> _loop(int gen) async {
    bool live() => _running && gen == _gen;
    while (live()) {
      final Channel ch;
      try {
        ch = await _connect(
          relay: host.relay,
          hostPub: host.pub,
          key: _identity.key,
        );
      } on ChannelError catch (e) {
        if (!live()) return;
        if (e.relayCode == 4403) {
          _running = false;
          _set(LinkState.unpaired);
          return;
        }
        _set(LinkState.offline);
        await _backoff();
        continue;
      } on Object {
        if (!live()) return;
        _set(LinkState.offline);
        await _backoff();
        continue;
      }
      if (!live()) {
        unawaited(ch.close());
        return;
      }
      _channel = ch;
      final onlineAt = _clock();
      final sub = ch.windows.listen((l) {
        _windows = l;
        _notify();
      });
      _set(LinkState.online);
      await ch.closed;
      await sub.cancel();
      if (identical(_channel, ch)) _channel = null;
      if (gen != _gen) return;
      _lastSeen = _clock();
      if (_clock().difference(onlineAt) >= const Duration(seconds: 60)) {
        _attempt = 0;
      }
      _set(LinkState.offline);
      _notify();
      if (!live()) return;
      await _backoff();
    }
  }

  Future<void> _backoff() {
    final base = minBackoff.inMilliseconds * pow(2, _attempt);
    _attempt++;
    final ms =
        min(base, maxBackoff.inMilliseconds.toDouble()) *
        (0.8 + _jitter() * 0.4);
    return _sleep(Duration(milliseconds: ms.round()));
  }
}

/// A link per paired host, made and dropped as the host list changes.
class Links extends ChangeNotifier {
  Links(
    this._hosts,
    this._connect,
    this._identity, {
    Future<void> Function(Duration)? sleep,
  }) : _sleep = sleep {
    _hosts.addListener(_sync);
    _sync();
  }

  final Hosts _hosts;
  final ChannelFactory _connect;
  final Identity _identity;
  final Future<void> Function(Duration)? _sleep;
  final _links = <String, HostLink>{};

  HostLink? of(String hostId) => _links[hostId];

  Iterable<HostLink> get all => _hosts.all.map((h) => _links[h.id]).nonNulls;

  void _sync() {
    final ids = {for (final h in _hosts.all) h.id};
    for (final id in [..._links.keys]) {
      if (!ids.contains(id)) _links.remove(id)!.dispose();
    }
    for (final h in _hosts.all) {
      _links.putIfAbsent(h.id, () {
        final l = HostLink(h, _connect, _identity, sleep: _sleep)
          ..addListener(notifyListeners);
        l.start();
        return l;
      });
    }
    notifyListeners();
  }

  /// The app spent long in the background: drop the connections until it is back.
  void pause() {
    for (final l in _links.values) {
      if (l.state != LinkState.unpaired) l.stop();
    }
  }

  void resume() {
    for (final l in _links.values) {
      if (l.state != LinkState.unpaired) l.start();
    }
  }

  @override
  void dispose() {
    _hosts.removeListener(_sync);
    for (final l in _links.values) {
      l.dispose();
    }
    _links.clear();
    super.dispose();
  }
}
