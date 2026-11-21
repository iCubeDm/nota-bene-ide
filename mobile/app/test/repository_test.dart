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

  setUp(() async {
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
      sleep: (_) => Completer<void>().future,
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
