import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/media/proxy.dart';
import 'package:nb_channel/nb_channel.dart';

/// What the proxy asked the channel for, and a canned answer.
class FakeOpen {
  FakeOpen(this.answer);
  final HttpStreamAnswer Function() answer;
  final asked = <(String, Map<String, String>)>[];

  Future<HttpStreamAnswer> call(String method, Map<String, String> h) async {
    asked.add((method, h));
    return answer();
  }
}

HttpStreamAnswer canned(
  int status,
  Map<String, String> headers,
  Stream<Uint8List> body, [
  void Function()? cancel,
]) => (status: status, headers: headers, body: body, cancel: cancel ?? () {});

Future<HttpClientResponse> get(
  Uri u, {
  Map<String, String> headers = const {},
  String method = 'GET',
}) async {
  final c = HttpClient();
  final r = await c.openUrl(method, u);
  headers.forEach(r.headers.set);
  return r.close();
}

void main() {
  test('a ranged request reaches the channel and its 206 comes back', () async {
    final open = FakeOpen(
      () => canned(206, {
        'content-type': 'video/mp4',
        'content-range': 'bytes 10-19/100',
        'content-length': '10',
        'accept-ranges': 'bytes',
        'etag': 'W/"1"',
        'set-cookie': 'no',
      }, Stream.value(Uint8List.fromList(utf8.encode('0123456789')))),
    );
    final p = await MediaProxy.start(open.call);
    expect(p.uri.host, '127.0.0.1');
    final r = await get(
      p.uri,
      headers: {'range': 'bytes=10-19', 'cookie': 'x', 'if-range': 'W/"1"'},
    );
    expect(r.statusCode, 206);
    expect(r.headers.value('content-range'), 'bytes 10-19/100');
    expect(r.headers.value('accept-ranges'), 'bytes');
    expect(r.headers.value('etag'), 'W/"1"');
    expect(r.headers.value('set-cookie'), isNull);
    expect(await utf8.decodeStream(r), '0123456789');
    expect(open.asked.single.$1, 'GET');
    expect(open.asked.single.$2, {'range': 'bytes=10-19', 'if-range': 'W/"1"'});
    await p.close();
  });

  test('another path is 404 and never reaches the channel', () async {
    final open = FakeOpen(() => canned(200, {}, const Stream.empty()));
    final p = await MediaProxy.start(open.call);
    final r = await get(p.uri.replace(path: '/other'));
    expect(r.statusCode, 404);
    await r.drain<void>();
    final post = await get(p.uri, method: 'POST');
    expect(post.statusCode, 404);
    await post.drain<void>();
    expect(open.asked, isEmpty);
    await p.close();
  });

  test('HEAD gets the head and cancels the body', () async {
    var cancelled = false;
    final open = FakeOpen(
      () => canned(
        200,
        {'content-length': '100'},
        const Stream.empty(),
        () => cancelled = true,
      ),
    );
    final p = await MediaProxy.start(open.call);
    final r = await get(p.uri, method: 'HEAD');
    expect(r.statusCode, 200);
    expect(r.contentLength, 100);
    await r.drain<void>();
    expect(cancelled, isTrue);
    await p.close();
  });

  test('a player that hangs up mid-body cancels the channel stream', () async {
    final gone = Completer<void>();
    final body = StreamController<Uint8List>(
      onCancel: () => gone.isCompleted ? null : gone.complete(),
    );
    final open = FakeOpen(
      () => canned(200, {'content-length': '${1 << 20}'}, body.stream, () {
        if (!gone.isCompleted) gone.complete();
      }),
    );
    final p = await MediaProxy.start(open.call);
    // the host keeps sending (a video does): the first write after the hang-up fails
    final tick = Timer.periodic(
      const Duration(milliseconds: 10),
      (_) => body.isClosed ? null : body.add(Uint8List(64 * 1024)),
    );
    final c = HttpClient();
    final req = await c.getUrl(p.uri);
    final r = await req.close();
    await r.first;
    c.close(force: true);
    await gone.future.timeout(const Duration(seconds: 5));
    tick.cancel();
    await p.close();
  });

  test('a channel that cannot answer is a 502', () async {
    final p = await MediaProxy.start(
      (_, _) async => throw StreamClosed(4904, 'the window has gone'),
    );
    final r = await get(p.uri);
    expect(r.statusCode, 502);
    await r.drain<void>();
    await p.close();
  });
}
