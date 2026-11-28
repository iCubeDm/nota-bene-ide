// The window's socket on its own (issue 511): reconnects and what it hands on, without a tab.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/agent_connection.dart';
import 'package:nb_app/chat/audio_clip.dart' show clipKey;
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/fakes.dart';

Future<void> settle() async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  late FakeFactory f;
  late HostLink link;
  late FakeChannel ch;
  late AgentConnection c;
  late List<String> calls;

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
    )..start();
    await settle();
    calls = [];
    late AgentConnection self;
    self = c = AgentConnection(
      link,
      window(4791, '/p'),
      onEvent: (e) => calls.add('${e.runtimeType}:${self.state.name}'),
      onSocket: () => calls.add('socket'),
      onOpen: () => calls.add('open:${self.state.name}'),
      retry: (_) async {},
    );
    await settle();
  });

  tearDown(() {
    c.dispose();
    link.dispose();
  });

  test(
    'one of a server\'s other agents: its socket and requests go under /a/<agent> on the server\'s port (epic 383)',
    () async {
      final w = window(4791, '/q', id: 'claude:q', agent: 'claude-abcdef');
      ch.push([window(4791, '/p'), w]);
      await settle();
      final a = AgentConnection(link, w, onEvent: (_) {}, retry: (_) async {})
        ..start();
      addTearDown(a.dispose);
      await settle();
      expect(ch.wsOpens.last, containsPair('port', 4791));
      expect(ch.wsOpens.last['path'], '/a/claude-abcdef/ws?held=1');
      expect(
        a.address.at('/file?path=a.md'),
        '/a/claude-abcdef/file?path=a.md',
      );
      expect(c.address.at('/file?path=a.md'), '/file?path=a.md');
      // two agents of one server, the same file: two clips, not one
      expect(clipKey(a, 'out/voice.m4a'), isNot(clipKey(c, 'out/voice.m4a')));
    },
  );

  test(
    'a folder open in one server under two agents (Claude first, Codex beside it): the Codex tab stays on its agent',
    () async {
      final codex = window(
        4791,
        '/p',
        id: 'codex:p',
        provider: AgentProvider.codex,
        agent: 'codex-abcdef',
      );
      ch.push([window(4791, '/p', id: 'claude:p'), codex]);
      await settle();
      final a = AgentConnection(
        link,
        codex,
        onEvent: (_) {},
        retry: (_) async {},
      );
      addTearDown(a.dispose);
      expect(a.window?.agent, 'codex-abcdef');
      expect(a.address.at('/ws'), '/a/codex-abcdef/ws');
    },
  );

  test('opens nothing until started', () async {
    expect(ch.wsOpens, isEmpty);
    c.start();
    await settle();
    expect(ch.wsOpens, hasLength(1));
    expect(calls, ['socket']);
  });

  group('started', () {
    setUp(() async {
      c.start();
      await settle();
      calls.clear();
    });

    test(
      'every client is live (issue 174): /ws?held=1, a replay goes on before the tab is open, the open after it',
      () async {
        expect(ch.wsOpens.single['path'], '/ws?held=1');
        ch.event(ch.lastWsId, {'kind': 'replay', 'events': <Object?>[]});
        ch.event(ch.lastWsId, {'kind': 'hello', 'protocol': floor.protocol});
        await settle();
        expect(calls, [
          'ServerEventReplay:connecting',
          'open:open',
          'ServerEventHello:open',
        ]);
        expect(c.has(Feature.looking), isTrue);
      },
    );

    test(
      'a window below the protocol floor (41: the shared read state) is not opened: old, its socket closed, nothing passed on',
      () async {
        expect(floor, Feature.looking);
        final id = ch.lastWsId;
        ch.event(id, {'kind': 'hello', 'protocol': floor.protocol - 1});
        ch.event(id, {'kind': 'replay', 'events': <Object?>[]});
        await settle();
        expect(c.state, TabState.old);
        expect(calls, isEmpty);
        expect(ch.lastWsId, id);
      },
    );

    test('a socket closed under a live link reopens after the retry', () async {
      ch.host(Close(ch.lastWsId, 1006));
      await settle();
      expect(ch.wsOpens, hasLength(2));
      expect(ch.wsOpens.last['path'], '/ws?held=1');
      expect(calls, ['socket']);
    });

    test(
      '4904: gone until a list after the close shows the window, then reopens',
      () async {
        ch.event(ch.lastWsId, {'kind': 'replay', 'events': <Object?>[]});
        await settle();
        ch.host(Close(ch.lastWsId, unknownWindow));
        await settle();
        expect(c.state, TabState.gone);
        ch.push([]);
        await settle();
        expect(ch.wsOpens, hasLength(1));
        ch.push([window(4791, '/p')]);
        await settle();
        expect(ch.wsOpens, hasLength(2));
        expect(c.state, TabState.connecting);
      },
    );

    test('send goes only while open', () async {
      expect(c.send(const ClientMessageInterrupt()), isFalse);
      ch.event(ch.lastWsId, {'kind': 'replay', 'events': <Object?>[]});
      await settle();
      expect(c.send(const ClientMessageInterrupt()), isTrue);
      await settle();
      expect(ch.sentOn(ch.lastWsId).single, {'type': 'interrupt'});
    });
  });
}
