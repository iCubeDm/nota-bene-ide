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
    this.onName,
    this.minBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 30),
    DateTime Function()? clock,
    double Function()? jitter,
    Future<void> Function(Duration)? sleep,
  }) : _clock = clock ?? DateTime.now,
       _jitter = jitter ?? Random().nextDouble,
       _sleep = sleep ?? ((d) => Future<void>.delayed(d));

  final PairedHost host;

  /// Called with the computer name the host sent on a connection.
  final void Function(String name)? onName;
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

  /// Completed by [refresh] and [stop] to end the backoff sleep at once.
  Completer<void>? _wake;

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
    if (_state != LinkState.online) _set(LinkState.connecting);
    unawaited(_loop(++_gen));
  }

  /// Pull to refresh: an online host is asked for its windows again (the channel stays); any other link reconnects at
  /// once, without waiting out its backoff. Completes when the host answered, the attempt ended or [timeout] passed.
  Future<void> refresh({Duration timeout = const Duration(seconds: 20)}) async {
    if (_state == LinkState.unpaired) return;
    final ch = _channel;
    if (_running && _state == LinkState.online && ch != null) {
      try {
        final list = await ch.refreshWindows(wait: timeout).timeout(timeout);
        if (identical(_channel, ch)) {
          _windows = list;
          _notify();
        }
      } on Object {
        // no answer: the stream of changes keeps the list, and a dead channel reconnects by itself
      }
      return;
    }
    final settled = Completer<void>();
    void watch() {
      if (_state != LinkState.connecting && !settled.isCompleted) {
        settled.complete();
      }
    }

    addListener(watch);
    try {
      if (!_running) {
        _attempt = 0;
        start();
      } else if (_state == LinkState.offline) {
        // the one loop is in its backoff sleep: end the sleep, never start a second loop (one key, one connection)
        _attempt = 0;
        _set(LinkState.connecting);
        _wakeUp();
      }
      await settled.future.timeout(timeout, onTimeout: () {});
    } finally {
      removeListener(watch);
    }
  }

  /// Drops the channel; the link shows offline until [start].
  void stop() {
    final was = _running;
    _running = false;
    _gen++;
    final ch = _channel;
    _channel = null;
    unawaited(ch?.close());
    _wakeUp();
    if (was && _state != LinkState.unpaired) {
      if (_state == LinkState.online) _lastSeen = _clock();
      _set(LinkState.offline);
    }
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
      _set(
        LinkState.connecting,
      ); // also while a retry connects, so a refresh never starts a second loop
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
      if (ch.hostName case final n?) onName?.call(n);
      final onlineAt = _clock();
      final sub = ch.windows.listen((l) {
        _windows = l;
        _notify();
      });
      _set(LinkState.online);
      final code = await ch.closed;
      await sub.cancel();
      if (identical(_channel, ch)) _channel = null;
      if (gen != _gen) return;
      _lastSeen = _clock();
      if (_clock().difference(onlineAt) >= const Duration(seconds: 60)) {
        _attempt = 0;
      }
      _set(LinkState.offline);
      _notify();
      if (code == 4409) {
        // this phone's key connected again elsewhere (a pairing run, a second copy): the relay keeps the newer one,
        // and a client closed so must not reconnect on its own (relay/PROTOCOL.md); start() resumes
        _running = false;
        return;
      }
      if (!live()) return;
      await _backoff();
    }
  }

  void _wakeUp() {
    final w = _wake;
    _wake = null;
    if (w != null && !w.isCompleted) w.complete();
  }

  Future<void> _backoff() async {
    final base = minBackoff.inMilliseconds * pow(2, _attempt);
    _attempt++;
    final ms =
        min(base, maxBackoff.inMilliseconds.toDouble()) *
        (0.8 + _jitter() * 0.4);
    final wake = _wake = Completer<void>();
    await Future.any([_sleep(Duration(milliseconds: ms.round())), wake.future]);
    if (identical(_wake, wake)) _wake = null;
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
    final current = {for (final h in _hosts.all) h.id: h};
    for (final id in [..._links.keys]) {
      // gone, or paired again (a new relay, a link that had stopped as unpaired): its link starts over
      if (!identical(current[id], _links[id]!.host)) {
        _links.remove(id)!.dispose();
      }
    }
    for (final h in _hosts.all) {
      _links.putIfAbsent(h.id, () {
        final l = HostLink(
          h,
          _connect,
          _identity,
          sleep: _sleep,
          onName: (n) => unawaited(_hosts.learnComputerName(h.id, n)),
        )..addListener(notifyListeners);
        l.start();
        return l;
      });
    }
    notifyListeners();
  }

  /// Stops one host's link (its key is about to connect for pairing; two connections with one key fight for the slot).
  void pauseHost(String id) => _links[id]?.stop();

  void resumeHost(String id) {
    final l = _links[id];
    if (l != null && l.state != LinkState.unpaired) l.start();
  }

  /// Pull to refresh: every link reconnects or asks its host for the windows again, all at once.
  Future<void> refresh() =>
      Future.wait([for (final l in _links.values) l.refresh()]);

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
