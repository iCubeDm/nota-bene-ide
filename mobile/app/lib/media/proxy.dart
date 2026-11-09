// A video plays from the host through the channel (the spec's loopback endpoint): the player is given a URL on
// 127.0.0.1, and every request it makes there, Range included, goes out as one streamed `http` stream of the channel.
// One proxy serves one file, under a random path, and only on the loopback address.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:nb_channel/nb_channel.dart';

/// Opens the file's request on the channel with the player's [method] and the headers passed on.
typedef OpenMedia =
    Future<HttpStreamAnswer> Function(
      String method,
      Map<String, String> headers,
    );

/// the player's request headers a ranged read needs (the channel passes these on)
const _ask = ['range', 'if-range', 'if-none-match', 'accept'];

/// the answer's headers a player reads
const _tell = [
  'content-type',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

class MediaProxy {
  MediaProxy._(this._server, this._token, this._open) {
    _server.listen(_serve);
  }

  final HttpServer _server;
  final String _token;
  final OpenMedia _open;
  final _live = <void Function()>{};

  static Future<MediaProxy> start(OpenMedia open) async {
    final r = Random.secure();
    final token = base64Url
        .encode([for (var i = 0; i < 24; i++) r.nextInt(256)])
        .replaceAll('=', '');
    return MediaProxy._(
      await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
      token,
      open,
    );
  }

  Uri get uri => Uri(
    scheme: 'http',
    host: '127.0.0.1',
    port: _server.port,
    path: '/$_token',
  );

  Future<void> _serve(HttpRequest q) async {
    final res = q.response;
    if (q.uri.path != '/$_token' || (q.method != 'GET' && q.method != 'HEAD')) {
      res.statusCode = HttpStatus.notFound;
      await res.close();
      return;
    }
    final HttpStreamAnswer a;
    try {
      a = await _open(q.method, {for (final k in _ask) k: ?q.headers.value(k)});
    } catch (_) {
      res.statusCode = HttpStatus.badGateway;
      await res.close();
      return;
    }
    _live.add(a.cancel);
    try {
      res.statusCode = a.status;
      for (final k in _tell) {
        if (a.headers[k] case final v?) res.headers.set(k, v);
      }
      if (int.tryParse(a.headers['content-length'] ?? '') case final n?) {
        res.contentLength = n;
      }
      if (q.method == 'HEAD') {
        a.cancel();
      } else {
        // a player that hangs up while the host is quiet is noticed here, not at the next write
        unawaited(
          res.done.then((_) {}, onError: (_) {}).whenComplete(a.cancel),
        );
        // the socket's pace: a player that reads slowly throttles the host; one that hangs up ends the stream (the
        // body is cancelled, which closes the channel stream)
        await res.addStream(a.body);
      }
      await res.close();
    } catch (_) {
      // the player hung up, or the host broke the stream off: nothing more to say on this request
      a.cancel();
      try {
        await res.close();
      } catch (_) {}
    } finally {
      _live.remove(a.cancel);
    }
  }

  /// Whether [close] has been called.
  bool get isClosed => _closed;
  bool _closed = false;

  Future<void> close() async {
    _closed = true;
    for (final c in [..._live]) {
      c();
    }
    await _server.close(force: true);
  }
}
