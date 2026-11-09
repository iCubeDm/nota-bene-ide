import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/media/fetch.dart';

Fetched ok(int n) => (bytes: Uint8List(n), etag: null, fail: null);
const gone = (bytes: null, etag: null, fail: FetchFail.notFound);

void main() {
  test('a key is loaded once while it is kept', () async {
    final c = MediaCache(maxBytes: 100);
    var loads = 0;
    Future<Fetched> load() async {
      loads++;
      return ok(10);
    }

    await c.get('a', load);
    await c.get('a', load);
    expect(loads, 1);
  });

  test(
    'the least recently used entries go when the bytes pass the cap',
    () async {
      final c = MediaCache(maxBytes: 10);
      final loads = <String>[];
      Future<Fetched> Function() load(String k) => () async {
        loads.add(k);
        return ok(4);
      };
      await c.get('a', load('a'));
      await c.get('b', load('b'));
      await c.get('a', load('a')); // a is the freshest now
      await c.get('c', load('c')); // 12 bytes: b, the oldest, goes
      expect(loads, ['a', 'b', 'c']);
      await c.get('a', load('a'));
      await c.get('c', load('c'));
      expect(loads, ['a', 'b', 'c']);
      await c.get('b', load('b'));
      expect(loads, ['a', 'b', 'c', 'b']);
    },
  );

  test('a failed read is forgotten', () async {
    final c = MediaCache(maxBytes: 10);
    var loads = 0;
    Future<Fetched> load() async {
      loads++;
      return gone;
    }

    await c.get('a', load);
    await c.get('a', load);
    expect(loads, 2);
  });

  test('a default cache holds 64 MB', () {
    expect(MediaCache().maxBytes, 64 * 1024 * 1024);
  });
}
