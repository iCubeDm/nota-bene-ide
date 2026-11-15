// What the phone has already notified about, per host and session: the reply count notified and whether the current wait
// was. Kept apart from Seen (a notification is no reading) and on disk, so the periodic check and the app never notify
// the same thing twice.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'seen.dart';
import 'vault.dart';

typedef NotifiedSession = ({int replies, bool waiting});

class Notified extends ChangeNotifier {
  Notified._(this._v, this._m);

  final Vault _v;
  final Map<String, Map<String, NotifiedSession>> _m;

  static const _slot = 'nb.notified';

  static Future<Notified> load(Vault v) async => Notified._(v, await _read(v));

  static Future<Map<String, Map<String, NotifiedSession>>> _read(
    Vault v,
  ) async {
    final m = <String, Map<String, NotifiedSession>>{};
    final s = await v.read(_slot);
    if (s == null) return m;
    try {
      (jsonDecode(s) as Map).forEach((h, sessions) {
        m[h as String] = {
          for (final e in (sessions as Map).entries)
            e.key as String: (
              replies: (e.value as Map)['r'] as int,
              waiting: (e.value as Map)['w'] == true,
            ),
        };
      });
    } on Object {
      // unreadable: start empty, as Seen does
      m.clear();
    }
    return m;
  }

  /// Reads the store again: another engine (the periodic check) may have written it.
  Future<void> reload() async {
    final m = await _read(_v);
    _m
      ..clear()
      ..addAll(m);
    notifyListeners();
  }

  NotifiedSession? of(String hostId, String session) => _m[hostId]?[session];

  /// Records [s] for [session], as the most recently updated of its host, within [Seen.maxPerHost]. Saved by [save].
  void put(String hostId, String session, NotifiedSession s) {
    final per = _m[hostId] ??= {};
    per.remove(session);
    per[session] = s;
    while (per.length > Seen.maxPerHost) {
      per.remove(per.keys.first);
    }
  }

  Future<void> save() => _v.write(
    _slot,
    jsonEncode({
      for (final h in _m.entries)
        h.key: {
          for (final s in h.value.entries)
            s.key: {'r': s.value.replies, 'w': s.value.waiting},
        },
    }),
  );

  /// Forgets the hosts that are not in [hostIds] any more.
  void prune(Set<String> hostIds) {
    final before = _m.length;
    _m.removeWhere((h, _) => !hostIds.contains(h));
    if (_m.length != before) unawaited(save());
  }
}
