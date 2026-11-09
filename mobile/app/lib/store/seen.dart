// How many final replies of each session the phone has shown, per host: the unread count of a row is what the window
// reports beyond that. Kept by host and session id, so a restarted window (new port) keeps its count.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart';

import 'vault.dart';

class Seen extends ChangeNotifier {
  Seen._(this._v, this._m);

  final Vault _v;
  final Map<String, Map<String, int>> _m;

  static const _slot = 'nb.seen';

  static Future<Seen> load(Vault v) async {
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
    return Seen._(v, m);
  }

  /// The replies shown of [session]; 0 when none is stored.
  int seenOf(String hostId, String session) => _m[hostId]?[session] ?? 0;

  Future<void> _save() => _v.write(_slot, jsonEncode(_m));

  /// Marks [replies] of [session] as shown.
  Future<void> see(String hostId, String session, int replies) async {
    if (_m[hostId]?[session] == replies) return;
    (_m[hostId] ??= {})[session] = replies;
    notifyListeners();
    await _save();
  }

  /// The replies of [w] not shown yet. A session met for the first time counts as seen up to its replies, and a count
  /// that dropped (a compaction, a new history) restarts from the lower one, so later replies are unread again.
  int unread(String hostId, HostWindow w) {
    final session = w.session, replies = w.replies;
    if (session == null || replies == null) return 0;
    final stored = _m[hostId]?[session];
    if (stored == null || replies < stored) {
      (_m[hostId] ??= {})[session] = replies;
      unawaited(_save());
      return 0;
    }
    return replies - stored;
  }
}
