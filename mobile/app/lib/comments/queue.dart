// The comment changes made here that the window has not acked yet (protocol 19), kept on disk so that they outlive the
// app: one JSON file in the app's [Files], `comment-ops.json`, for every window by host and session, written whole.
import 'dart:convert';

import 'package:nb_protocol/nb_protocol.dart';

import '../store/storage.dart';

/// One window's queued changes, oldest first.
class CommentQueue {
  CommentQueue._(this._store);

  /// Kept in memory only.
  CommentQueue.memory() : _store = null;

  final CommentQueues? _store;
  final ops = <ClientMessageCommentOp>[];

  /// Done once what the disk had is in [ops].
  Future<void> get ready => _store?.ready ?? Future.value();

  void save() => _store?._save();
}

/// All the queues of the app, by window (host and session).
class CommentQueues {
  CommentQueues(this.files) {
    ready = _load();
  }

  static const path = 'comment-ops.json';

  final Files files;
  late final Future<void> ready;
  final _queues = <String, CommentQueue>{};
  Future<void> _writes = Future.value();

  Future<void> _load() async {
    try {
      final s = await files.readText(path);
      if (s == null) return;
      final m = (jsonDecode(s) as Map).cast<String, Object?>();
      for (final MapEntry(:key, :value) in m.entries) {
        // what the disk had is older than anything queued since the app started
        of(key).ops.insertAll(0, [
          for (final o in value as List)
            ClientMessageCommentOp.fromJson((o as Map).cast<String, Object?>()),
        ]);
      }
    } on Object {
      // an unreadable file: start empty
    }
  }

  CommentQueue of(String key) => _queues[key] ??= CommentQueue._(this);

  /// Writes every queue, one write after another; not before the file was read (it would lose what it had).
  void _save() {
    _writes = _writes
        .then((_) => ready)
        .then(
          (_) => files.writeText(
            path,
            jsonEncode({
              for (final MapEntry(:key, :value) in _queues.entries)
                if (value.ops.isNotEmpty)
                  key: [for (final o in value.ops) o.toJson()],
            }),
          ),
        )
        .catchError((Object _) {});
  }
}
