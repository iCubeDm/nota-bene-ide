// The window's data over its connection (issue 547): one load path, as the web's repository.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/agent_connection.dart';
import 'package:nb_app/files/repository.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';

Future<void> settle() async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

HttpAnswer json(Object v) => (
  status: 200,
  headers: const <String, String>{},
  body: Uint8List.fromList(utf8.encode(jsonEncode(v))),
);

void main() {
  late FakeFactory f;
  late HostLink link;
  late FakeChannel ch;
  late AgentConnection c;
  late Repository repo;
  late Completer<void> wake;

  setUp(() async {
    wake = Completer<void>();
    f = FakeFactory();
    ch = FakeChannel([window(4791, '/p')]);
    f.results.add(ch);
    link = HostLink(
      PairedHost(
        id: b64u(List.filled(32, 1)),
        relay: Uri.parse('wss://r.example'),
        label: 'h',
        pairedAt: DateTime(2026),
      ),
      f.factory,
      await Identity.load(MemoryVault()),
      sleep: (_) => wake.future,
    );
    c = AgentConnection(link, window(4791, '/p'), onEvent: (_) {});
    repo = Repository(c);
  });

  tearDown(() {
    c.dispose();
    link.dispose();
  });

  test('asks nothing while the host is offline', () async {
    await expectLater(
      repo.tree(''),
      throwsA(isA<FilesError>().having((e) => e.status, 'status', isNull)),
    );
    expect(ch.requests, isEmpty);
  });

  group('online', () {
    setUp(() async {
      link.start();
      await settle();
    });

    test('one request for the same route in flight, a new one after', () async {
      final answer = Completer<HttpAnswer>();
      ch.onHttp = (_, _, _) => answer.future;
      final a = repo.tree('src'), b = repo.tree('src'), other = repo.tree('');
      expect(ch.requests, ['GET /tree?path=src', 'GET /tree?path=']);
      answer.complete(
        json([
          {'name': 'b', 'path': 'src/b', 'dir': false},
          {'name': 'a', 'path': 'src/a', 'dir': true},
        ]),
      );
      expect((await a).map((e) => e.name), ['a', 'b']);
      expect(
        identical(await a, await b),
        isFalse,
      ); // each caller parses its own
      await other;
      await repo.tree('src');
      expect(ch.requests, hasLength(3));
    });

    test('a read after a write does not join one from before it', () async {
      final before = Completer<HttpAnswer>();
      ch.onHttp = (_, m, _) =>
          m == 'GET' ? before.future : Future.value(json({}));
      final a = repo.get('/usage?provider=claude&period=trip');
      await repo.write('POST', '/usage/reset');
      ch.onHttp = (_, _, _) async => json(2);
      final b = repo.get('/usage?provider=claude&period=trip');
      expect(ch.requests, [
        'GET /usage?provider=claude&period=trip',
        'POST /usage/reset',
        'GET /usage?provider=claude&period=trip',
      ]);
      before.complete(json(1));
      expect(utf8.decode((await a).body), '1');
      expect(utf8.decode((await b).body), '2');
    });

    test('the same route with other headers is another request', () async {
      final answer = Completer<HttpAnswer>();
      ch.onHttp = (_, _, _) => answer.future;
      final a = repo.get('/file?path=a');
      final b = repo.get('/file?path=a', headers: {'range': 'bytes=0-9'});
      expect(ch.requests, ['GET /file?path=a', 'GET /file?path=a']);
      answer.complete(json(1));
      await Future.wait([a, b]);
    });

    test(
      'after a reconnect, a request does not wait on the old channel',
      () async {
        ch.onHttp = (_, _, _) =>
            Completer<HttpAnswer>().future; // never answers
        unawaited(repo.tree('src'));
        final next = FakeChannel([window(4791, '/p')])
          ..onHttp = (_, _, _) async => json([]);
        f.results.add(next);
        ch.drop();
        wake.complete();
        await settle();
        expect(identical(link.channel, next), isTrue);
        expect(await repo.tree('src'), isEmpty);
        expect(next.requests, ['GET /tree?path=src']);
      },
    );

    test('a refusal is its status; a broken stream has none', () async {
      ch.onHttp = (_, _, _) async =>
          (status: 403, headers: const <String, String>{}, body: Uint8List(0));
      await expectLater(
        repo.complete('x'),
        throwsA(isA<FilesError>().having((e) => e.outside, 'outside', true)),
      );
      ch.onHttp = null;
      await expectLater(
        repo.log(),
        throwsA(isA<FilesError>().having((e) => e.status, 'status', isNull)),
      );
      expect(await repo.isGitRepo(), isNull);
    });
  });
}
