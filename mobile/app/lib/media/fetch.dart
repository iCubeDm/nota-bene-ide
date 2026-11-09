// An image of the window read through the channel's http stream: `/file`, `/tmpimage` or `/attach/<id>`, counted as
// it comes so a body past the limit is cut off, never held.
import 'dart:typed_data';

import '../chat/window_tab.dart';

/// The largest image the phone opens.
const imageMaxBytes = 32 * 1024 * 1024;

enum FetchFail { notFound, outside, tooLarge, unreadable }

typedef Fetched = ({Uint8List? bytes, String? etag, FetchFail? fail});

/// GET [url] from [tab]'s window. Never throws: a failure is the answer.
Future<Fetched> fetchMedia(WindowTab tab, String url) async {
  Fetched failed(FetchFail f) => (bytes: null, etag: null, fail: f);
  final ch = tab.link.channel;
  if (ch == null) return failed(FetchFail.unreadable);
  try {
    final r = await ch.httpStream(tab.port, 'GET', url);
    final length = int.tryParse(r.headers['content-length'] ?? '');
    final bad = switch (r.status) {
      200 => null,
      404 => FetchFail.notFound,
      403 => FetchFail.outside,
      413 => FetchFail.tooLarge,
      _ => FetchFail.unreadable,
    };
    if (bad != null) {
      r.cancel();
      return failed(bad);
    }
    if (length != null && length > imageMaxBytes) {
      r.cancel();
      return failed(FetchFail.tooLarge);
    }
    // without a length the body is counted as it comes
    final body = BytesBuilder(copy: false);
    await for (final c in r.body) {
      body.add(c);
      if (body.length > imageMaxBytes) {
        r.cancel();
        return failed(FetchFail.tooLarge);
      }
    }
    return (bytes: body.takeBytes(), etag: r.headers['etag'], fail: null);
  } on Object {
    return failed(FetchFail.unreadable);
  }
}

/// What a tab keeps of the images it read: the least recently used first, within [maxBytes] of image bytes.
class MediaCache {
  MediaCache({this.maxBytes = 64 * 1024 * 1024});
  final int maxBytes;
  final _entries = <String, Future<Fetched>>{}; // insertion order = recency
  final _sizes = <String, int>{};
  var _total = 0;

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

/// [fetchMedia] for a card or the viewer. An attachment's id is its content hash, so its read is kept in the tab's
/// [MediaCache]; a `/file` or `/tmpimage` read is the caller's alone (a file changes or goes, and every tool call asks
/// again).
Future<Fetched> cachedMedia(WindowTab tab, String url) =>
    url.startsWith('/attach/')
    ? tab.mediaCache.get(url, () => fetchMedia(tab, url))
    : fetchMedia(tab, url);
