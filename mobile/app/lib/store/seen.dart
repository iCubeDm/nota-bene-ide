// How many final replies of each session the phone has shown, per host: the unread count of a row is what the window
// reports beyond that. Kept by host and session id, so a restarted window (new port) keeps its count.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart';

import '../hosts/host_link.dart';
import 'hosts.dart' show Hosts;
import 'vault.dart';

class Seen extends ChangeNotifier {
  Seen._(this._v, this._m);

  final Vault _v;
  final Map<String, Map<String, int>> _m;

  static const _slot = 'nb.seen';

  /// Sessions kept per host: the most recently updated ones.
  static const maxPerHost = 200;

  Hosts? _hosts;
  Links? _links;

  static Future<Seen> load(Vault v) async => Seen._(v, await _read(v));

  /// Reads the store again: another engine (the periodic check) may have written it.
  Future<void> reload() async {
    final m = await _read(_v);
    _m
      ..clear()
      ..addAll(m);
    notifyListeners();
  }

  static Future<Map<String, Map<String, int>>> _read(Vault v) async {
    final m = <String, Map<String, int>>{};
    final s = await v.read(_slot);
    if (s != null) {
      try {
        (jsonDecode(s) as Map).forEach((h, sessions) {
          m[h as String] = {
            for (final e in (sessions as Map).entries)
              e.key as String: e.value as int,
          };
        });
      } on Object {
        // unreadable: start empty; the stored text stays until the next change
        m.clear();
      }
    }
    return m;
  }

  /// Follows the host stream: a session met for the first time counts as seen up to its replies (recorded when the
  /// window list arrives, never while a row is built), and the entries of an unpaired host are dropped.
  void watch(Hosts hosts, Links links) {
    unwatch();
    _hosts = hosts;
    _links = links;
    hosts.addListener(_onHosts);
    links.addListener(_onLinks);
    _onHosts();
    _onLinks();
  }

  void unwatch() {
    _hosts?.removeListener(_onHosts);
    _links?.removeListener(_onLinks);
    _hosts = _links = null;
  }

  @override
  void dispose() {
    unwatch();
    super.dispose();
  }

  void _onHosts() => prune({for (final h in _hosts!.all) h.id});

  void _onLinks() {
    for (final l in _links!.all) {
      observe(l.host.id, l.windows);
    }
  }

  /// The replies shown of [session]; 0 when none is stored.
  int seenOf(String hostId, String session) => _m[hostId]?[session] ?? 0;

  Future<void> _save() => _v.write(_slot, jsonEncode(_m));

  /// Stores [replies] for [session], as the most recently updated of its host, within [maxPerHost].
  void _put(String hostId, String session, int replies) {
    final per = _m[hostId] ??= {};
    per.remove(session);
    per[session] = replies;
    while (per.length > maxPerHost) {
      per.remove(per.keys.first);
    }
  }

  /// Marks [replies] of [session] as shown.
  Future<void> see(String hostId, String session, int replies) async {
    if (_m[hostId]?[session] == replies) return;
    _put(hostId, session, replies);
    notifyListeners();
    await _save();
  }

  /// Takes the windows a host listed: a session met for the first time counts as seen up to its replies, and a count
  /// that dropped (a compaction, a new history) restarts from the lower one, so later replies are unread again.
  void observe(String hostId, Iterable<HostWindow> windows) {
    var changed = false;
    for (final w in windows) {
      final session = w.session, replies = w.replies;
      if (session == null || replies == null) continue;
      final stored = _m[hostId]?[session];
      if (stored == null || replies < stored) {
        _put(hostId, session, replies);
        changed = true;
      }
    }
    if (!changed) return;
    notifyListeners();
    unawaited(_save());
  }

  /// Forgets the hosts that are not in [hostIds] any more.
  void prune(Set<String> hostIds) {
    final before = _m.length;
    _m.removeWhere((h, _) => !hostIds.contains(h));
    if (_m.length == before) return;
    notifyListeners();
    unawaited(_save());
  }

  /// The replies of [w] not shown yet; 0 for a session not observed yet (recorded when the window list arrives).
  int unread(String hostId, HostWindow w) {
    final session = w.session, replies = w.replies;
    if (session == null || replies == null) return 0;
    final stored = _m[hostId]?[session];
    return stored == null || replies < stored ? 0 : replies - stored;
  }
}
