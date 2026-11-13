// The comment changes made here that the window has not acked yet (protocol 19), kept on disk so that they outlive the
// app: one JSON file, `filesDir/comment-ops.json`, for every window by host and session, written whole (.part, rename).
import 'dart:convert';
import 'dart:io';

import 'package:nb_protocol/nb_protocol.dart';

import '../voice/player.dart' show playChannel;

/// Where the queues are kept; the app's files dir on the phone.
abstract class QueueFile {
  Future<String?> read();
  Future<void> write(String json);
}

/// `filesDir/comment-ops.json`, beside `nb/play`'s `outDir`; where the platform has none (tests), nothing is kept.
class DiskQueueFile implements QueueFile {
  Future<File?> _file() async {
    try {
      final p = await playChannel.invokeMethod<String>('outDir');
      return p == null
          ? null
          : File('${Directory(p).parent.path}/comment-ops.json');
    } on Object {
      return null;
    }
  }

  @override
  Future<String?> read() async {
    final f = await _file();
    return f != null && await f.exists() ? f.readAsString() : null;
  }

  @override
  Future<void> write(String json) async {
    final f = await _file();
    if (f == null) return;
    final part = File('${f.path}.part');
    await part.writeAsString(json, flush: true);
    await part.rename(f.path);
  }
}

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
  CommentQueues(this.file) {
    ready = _load();
  }

  /// The one the app uses; tests put their own.
  static CommentQueues instance = CommentQueues(DiskQueueFile());

  final QueueFile file;
  late final Future<void> ready;
  final _queues = <String, CommentQueue>{};
  Future<void> _writes = Future.value();

  Future<void> _load() async {
    try {
      final s = await file.read();
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
          (_) => file.write(
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
