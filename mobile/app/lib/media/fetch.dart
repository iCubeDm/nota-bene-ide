// An image of the window read through the channel's http stream: `/file`, `/tmpimage` or `/attach/<id>`, counted as
// it comes so a body past the limit is cut off, never held.
import 'dart:async';
import 'dart:typed_data';

import '../chat/window_tab.dart';

/// The largest image the phone opens.
const imageMaxBytes = 32000000;

/// The largest image previewed in the text (issue 459); a larger one opens full screen on a tap.
const previewMaxBytes = 8 * 1024 * 1024;

enum FetchFail { notFound, outside, tooLarge, unreadable }

typedef Fetched = ({Uint8List? bytes, String? etag, FetchFail? fail});

/// What a window's answer [status] means for a read: null when it is the file.
FetchFail? fetchFailOf(int status) => switch (status) {
  200 => null,
  404 => FetchFail.notFound,
  403 => FetchFail.outside,
  413 => FetchFail.tooLarge,
  _ => FetchFail.unreadable,
};

/// GET [url] from [tab]'s window, at most [max] bytes. Never throws: a failure is the answer. Once [abandoned]
/// completes the read stops, its stream is cancelled, and it gives nothing (issue 459).
Future<Fetched> fetchMedia(
  WindowTab tab,
  String url, {
  int max = imageMaxBytes,
  Future<void>? abandoned,
}) async {
  Fetched failed(FetchFail f) => (bytes: null, etag: null, fail: f);
  final ch = tab.connection.link.channel;
  if (ch == null) return failed(FetchFail.unreadable);
  var gone = false;
  abandoned?.then((_) => gone = true);
  try {
    final r = await ch.httpStream(tab.connection.port, 'GET', url);
    final length = int.tryParse(r.headers['content-length'] ?? '');
    final bad = fetchFailOf(r.status);
    if (gone || bad != null || (length != null && length > max)) {
      r.cancel();
      return failed(gone ? FetchFail.unreadable : bad ?? FetchFail.tooLarge);
    }
    // without a length the body is counted as it comes
    final body = BytesBuilder(copy: false);
    final end = Completer<FetchFail?>();
    late final StreamSubscription<List<int>> sub;
    void finish(FetchFail? fail) {
      if (end.isCompleted) return;
      if (fail != null) {
        unawaited(sub.cancel());
        r.cancel();
      }
      end.complete(fail);
    }

    sub = r.body.listen(
      (c) {
        body.add(c);
        if (body.length > max) finish(FetchFail.tooLarge);
      },
      onError: (Object _) => finish(FetchFail.unreadable),
      onDone: () => finish(null),
      cancelOnError: true,
    );
    abandoned?.then((_) => finish(FetchFail.unreadable));
    final fail = await end.future;
    if (fail != null) return failed(fail);
    return (bytes: body.takeBytes(), etag: r.headers['etag'], fail: null);
  } on Object {
    return failed(FetchFail.unreadable);
  }
}

/// What a HEAD of [url] says: why it cannot be read, or its etag. Nothing of the file is read. Never throws.
Future<({FetchFail? fail, String? etag})> headMedia(
  WindowTab tab,
  String url,
) async {
  final ch = tab.connection.link.channel;
  if (ch == null) return (fail: FetchFail.unreadable, etag: null);
  try {
    final r = await ch.httpStream(tab.connection.port, 'HEAD', url);
    r.cancel();
    return (fail: fetchFailOf(r.status), etag: r.headers['etag']);
  } on Object {
    return (fail: FetchFail.unreadable, etag: null);
  }
}

/// What a tab keeps of the images it read: the least recently used first, within [maxBytes] of image bytes.
class MediaCache {
  MediaCache({this.maxBytes = 64 * 1024 * 1024});
  final int maxBytes;
  final _entries = <String, Future<Fetched>>{}; // insertion order = recency
  final _sizes = <String, int>{};
  var _total = 0;

  final _users = <String, int>{};
  final _stops = <String, Completer<void>>{};

  /// [key]'s read when it is kept (the freshest now), else null.
  Future<Fetched>? peek(String key) {
    final kept = _entries.remove(key);
    if (kept != null) _entries[key] = kept;
    return kept;
  }

  /// [got] kept as [key]'s read, in place of what was.
  void put(String key, Fetched got) {
    if (_entries.remove(key) != null) _total -= _sizes.remove(key) ?? 0;
    get(key, () => Future.value(got));
  }

  /// [key]'s read as [get], held until [release]: when the last holder lets go before it came, [load]'s `abandoned`
  /// completes and nothing of it is kept (issue 459: a preview scrolled away stops its read).
  ({Future<Fetched> got, void Function() release}) hold(
    String key,
    Future<Fetched> Function(Future<void> abandoned) load,
  ) {
    _users[key] = (_users[key] ?? 0) + 1;
    final got = get(key, () {
      final stop = _stops[key] = Completer<void>();
      final f = load(stop.future);
      f.whenComplete(() {
        if (identical(_stops[key], stop)) _stops.remove(key);
      });
      return f;
    });
    var released = false;
    return (
      got: got,
      release: () {
        if (released) return;
        released = true;
        final n = (_users[key] ?? 1) - 1;
        if (n > 0) {
          _users[key] = n;
          return;
        }
        _users.remove(key);
        final stop = _stops.remove(key);
        if (stop != null && !stop.isCompleted) {
          _entries.remove(key);
          stop.complete();
        }
      },
    );
  }

  /// [key]'s read, started with [load] when it is not kept. A failed read is forgotten, so the next ask tries again.
  Future<Fetched> get(String key, Future<Fetched> Function() load) {
    final kept = _entries.remove(key);
    if (kept != null) {
      _entries[key] = kept; // the freshest now
      return kept;
    }
    final f = _entries[key] = load();
    f.then((r) {
      if (!identical(_entries[key], f)) return;
      final n = r.bytes?.length;
      if (r.fail != null || n == null) {
        _entries.remove(key);
        return;
      }
      _sizes[key] = n;
      _total += n;
      while (_total > maxBytes && _entries.isNotEmpty) {
        final oldest = _entries.keys.first;
        _entries.remove(oldest);
        _total -= _sizes.remove(oldest) ?? 0;
      }
    });
    return f;
  }
}

/// [url] (a project file) for the viewer: the bytes a preview kept when a HEAD finds the file unchanged (the same
/// etag), else read again, and kept in place of the old ones (issue 459).
Future<Fetched> viewedFile(WindowTab tab, String url) async {
  final kept = await tab.mediaCache.peek(url);
  if (kept != null && kept.bytes != null && kept.etag != null) {
    final h = await headMedia(tab, url);
    if (h.fail == null && h.etag == kept.etag) return kept;
  }
  final got = await fetchMedia(tab, url);
  if (kept != null && got.bytes != null) tab.mediaCache.put(url, got);
  return got;
}

/// [fetchMedia] for a card or the viewer. An attachment's id is its content hash, so its read is kept in the tab's
/// [MediaCache]; a `/file` or `/tmpimage` read is the caller's alone (a file changes or goes, and every tool call asks
/// again).
Future<Fetched> cachedMedia(WindowTab tab, String url) =>
    url.startsWith('/attach/')
    ? tab.mediaCache.get(url, () => fetchMedia(tab, url))
    : fetchMedia(tab, url);
