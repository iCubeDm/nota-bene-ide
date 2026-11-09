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

/// [fetchMedia] kept per tab for its life (an attachment's id is its content hash; a card is not asked twice). A
/// failed read is forgotten, so the next card to ask tries again.
Future<Fetched> cachedMedia(WindowTab tab, String url) {
  final f = tab.mediaCache.putIfAbsent(url, () => fetchMedia(tab, url));
  f.then((r) {
    if (r.fail != null) tab.mediaCache.remove(url);
  });
  return f;
}
