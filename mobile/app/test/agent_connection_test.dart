// The window's socket on its own (issue 511): the one-tab rule, reconnects and what it hands on, without a tab.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/agent_connection.dart';
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
      expect(ch.wsOpens.last['path'], startsWith('/a/claude-abcdef/ws?tab='));
      expect(a.at('/file?path=a.md'), '/a/claude-abcdef/file?path=a.md');
      expect(c.at('/file?path=a.md'), '/file?path=a.md');
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
      'a replay goes on before the tab is open; the open after it; occupied stays here',
      () async {
        ch.event(ch.lastWsId, {'kind': 'occupied'});
        ch.event(ch.lastWsId, {'kind': 'hello', 'protocol': 27});
        ch.event(ch.lastWsId, {'kind': 'replay', 'events': <Object?>[]});
        await settle();
        expect(calls, [
          'ServerEventHello:occupied',
          'ServerEventReplay:occupied',
          'open:open',
        ]);
        expect(c.protocol, 27);
        expect(c.has(Feature.compactOrder), isTrue);
      },
    );

    test('4001: taken, no reconnect of its own', () async {
      ch.event(ch.lastWsId, {'kind': 'replay', 'events': <Object?>[]});
      await settle();
      ch.host(Close(ch.lastWsId, takenOverCode));
      await settle();
      expect(c.state, TabState.taken);
      expect(c.send(const ClientMessageInterrupt()), isFalse);
      ch.push([window(4791, '/p')]);
      await settle();
      expect(ch.wsOpens, hasLength(1));
    });

    test(
      'Work here after 4001 reopens passive; the takeover wish is kept until an occupied takes it',
      () async {
        ch.event(ch.lastWsId, {'kind': 'replay', 'events': <Object?>[]});
        await settle();
        ch.host(Close(ch.lastWsId, takenOverCode));
        await settle();
        c.takeOver();
        await settle();
        expect(ch.wsOpens.last['path'], endsWith('&passive=1'));
        expect(
          ch.sentOn(ch.lastWsId),
          isEmpty,
          reason: 'nothing to answer yet',
        );
        ch.event(ch.lastWsId, {'kind': 'occupied'});
        await settle();
        expect(ch.sentOn(ch.lastWsId).single, {'type': 'takeover'});
        expect(c.state, isNot(TabState.occupied));
        ch.event(ch.lastWsId, {'kind': 'replay', 'events': <Object?>[]});
        await settle();
        expect(c.state, TabState.open);
        // the wish went with the replay: a later occupied is shown, not answered
        ch.host(Close(ch.lastWsId, 1006));
        await settle();
        expect(
          ch.wsOpens.last['path'],
          isNot(endsWith('&passive=1')),
          reason: 'the replay made it the owner again',
        );
        ch.event(ch.lastWsId, {'kind': 'occupied'});
        await settle();
        expect(c.state, TabState.occupied);
        expect(ch.sentOn(ch.lastWsId), isEmpty);
      },
    );

    test(
      'a socket closed under a live link reopens after the retry; passive while occupied',
      () async {
        ch.event(ch.lastWsId, {'kind': 'occupied'});
        await settle();
        ch.host(Close(ch.lastWsId, 1006));
        await settle();
        expect(ch.wsOpens, hasLength(2));
        expect(ch.wsOpens.last['path'], endsWith('&passive=1'));
        expect(calls, ['socket']);
      },
    );

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
