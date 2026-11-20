import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/feed.dart';
import 'package:nb_app/chat/window_tab.dart';
import 'package:nb_app/comments/queue.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/fakes.dart';
import 'support/voice_fakes.dart';

Future<void> settle() async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

Map<String, Object?> replay(List<Map<String, Object?>> events) => {
  'kind': 'replay',
  'events': events,
};
Map<String, Object?> user(String id) => {
  'kind': 'user',
  'id': id,
  'text': id,
  'ts': 1,
  'historic': true,
};

void main() {
  late FakeFactory f;
  late HostLink link;
  late FakeChannel ch;
  late WindowTab tab;

  setUp(() async {
    // the comment queues are the app's: each test starts with an empty one
    CommentQueues.instance = CommentQueues(MemoryQueueFile());
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
    tab = WindowTab(link, 4791, '/p', retry: (_) async {});
    await settle();
  });

  tearDown(() {
    tab.dispose();
    link.dispose();
  });

  test('opens /ws with a tab id and waits for the replay', () async {
    final path = ch.wsOpens.single['path'] as String;
    expect(path, matches(RegExp(r'^/ws\?tab=[0-9a-f-]{36}$')));
    expect(tab.state, TabState.connecting);
    ch.event(ch.lastWsId, {'kind': 'hello', 'protocol': 13});
    ch.event(ch.lastWsId, replay([user('u1')]));
    await settle();
    expect(tab.state, TabState.open);
    expect(tab.feed.items.single, isA<UserItem>());
    expect(tab.protocol, 13);
  });

  test('occupied then Work here sends takeover and opens on replay', () async {
    ch.event(ch.lastWsId, {'kind': 'occupied'});
    await settle();
    expect(tab.state, TabState.occupied);
    tab.takeOver();
    await settle();
    expect(ch.sentOn(ch.lastWsId).single, {'type': 'takeover'});
    ch.event(ch.lastWsId, replay([user('u1')]));
    await settle();
    expect(tab.state, TabState.open);
  });

  test(
    '4001 goes to taken and does not reconnect; Work here reopens passive',
    () async {
      ch.event(ch.lastWsId, replay([]));
      await settle();
      ch.event(ch.lastWsId, {'kind': 'taken-over'});
      ch.host(Close(ch.lastWsId, 4001));
      await settle();
      expect(tab.state, TabState.taken);
      expect(ch.wsOpens, hasLength(1));
      tab.takeOver();
      await settle();
      expect(ch.wsOpens, hasLength(2));
      expect(ch.wsOpens.last['path'], endsWith('&passive=1'));
      ch.event(ch.lastWsId, {'kind': 'occupied'});
      await settle();
      expect(ch.sentOn(ch.lastWsId).single, {
        'type': 'takeover',
      }, reason: 'the wanted takeover goes at once');
      expect(tab.state, isNot(TabState.occupied));
    },
  );

  test('reconnect keeps the tab id and replaces the feed', () async {
    final first = ch.wsOpens.single['path'];
    ch.event(ch.lastWsId, replay([user('u1')]));
    await settle();
    // the network drops; the link comes back on a new channel
    final ch2 = FakeChannel([window(4791, '/p')]);
    f.results.add(ch2);
    ch.drop();
    await settle();
    expect(tab.state, TabState.offline);
    expect(tab.feed.items, hasLength(1), reason: 'what arrived stays readable');
    // the link's backoff sleeps forever in this test: let it go now
    link.stop();
    link.start();
    await settle();
    expect(ch2.wsOpens.single['path'], first);
    ch2.event(ch2.lastWsId, replay([user('u1'), user('u2')]));
    await settle();
    expect(tab.feed.items.map((i) => (i as UserItem).id), ['u1', 'u2']);
  });

  test(
    'issue 494: changes made while the socket was down go once on the next one, after its hello',
    () async {
      final told = <void>[];
      final sub = tab.comments.changedElsewhere.listen(told.add);
      Future<void> connect(int id) async {
        ch.event(id, replay([]));
        ch.event(id, {'kind': 'comments', 'items': <Object?>[]});
        ch.event(id, {'kind': 'hello', 'protocol': 19});
        await settle();
      }

      await connect(ch.lastWsId);
      final first = ch.lastWsId;
      ch.host(Close(first, 1006));
      await settle();
      final x = Comment.fromJson({
        'id': 'x',
        'anchor': {
          'source': {'kind': 'file', 'path': 'a.md'},
          'start': 0,
          'end': 1,
          'quote': 'q',
          'prefix': '',
          'suffix': '',
        },
        'text': 't',
        'status': 'pending',
        'createdAt': 1,
      });
      tab.comments.add(x.anchor, 'offline', null, id: 'x');
      tab.comments.remove('x');
      await settle();
      expect(ch.lastWsId, isNot(first), reason: 'the tab reopened its socket');
      ch.event(ch.lastWsId, replay([]));
      ch.event(ch.lastWsId, {'kind': 'comments', 'items': <Object?>[]});
      await settle();
      expect(
        ch.sentOn(ch.lastWsId).where((m) => m['type'] == 'comment-op'),
        isEmpty,
        reason: 'nothing goes before the hello',
      );
      ch.event(ch.lastWsId, {'kind': 'hello', 'protocol': 19});
      await settle();
      final ops = [
        for (final m in ch.sentOn(ch.lastWsId))
          if (m['type'] == 'comment-op')
            ((m['ops'] as List).single as Map)['op'],
      ];
      expect(ops, ['add', 'remove']);
      expect(told, isEmpty);
      await sub.cancel();
    },
  );

  test('4904 waits until the window is listed again, then reopens', () async {
    ch.event(ch.lastWsId, replay([user('u1')]));
    await settle();
    ch.push([]);
    ch.host(Close(ch.lastWsId, 4904));
    await settle();
    expect(tab.state, TabState.gone);
    expect(ch.wsOpens, hasLength(1));
    expect(tab.feed.items, hasLength(1));
    ch.push([window(4791, '/p')]);
    await settle();
    expect(ch.wsOpens, hasLength(2));
  });

  test('send writes JSON on the stream only while open', () async {
    tab.send(const ClientMessageInterrupt());
    await settle();
    expect(ch.sentOn(ch.lastWsId), isEmpty);
    ch.event(ch.lastWsId, replay([]));
    await settle();
    tab.send(const ClientMessageInterrupt());
    await settle();
    expect(ch.sentOn(ch.lastWsId).single, {'type': 'interrupt'});
  });

  test('models, model and send-refused are kept', () async {
    ch.event(ch.lastWsId, replay([]));
    ch.event(ch.lastWsId, {
      'kind': 'models',
      'models': [
        {
          'value': 'opus',
          'name': 'Opus',
          'description': 'd',
          'efforts': ['low', 'high'],
        },
      ],
    });
    ch.event(ch.lastWsId, {'kind': 'model', 'model': 'opus', 'effort': 'high'});
    final refused = tab.refusals.first;
    ch.event(ch.lastWsId, {
      'kind': 'send-refused',
      'id': 's1',
      'reason': 'busy',
    });
    await settle();
    expect(tab.models.single.value, 'opus');
    expect((tab.model, tab.effort), ('opus', AgentEffort.high));
    expect((await refused).id, 's1');
  });

  test('4904 with the port still listed waits for a fresh list', () async {
    ch.event(ch.lastWsId, replay([]));
    await settle();
    ch.host(Close(ch.lastWsId, 4904));
    await settle();
    expect(tab.state, TabState.gone);
    expect(
      ch.wsOpens,
      hasLength(1),
      reason: 'no tight reopen loop on a list from before the close',
    );
    ch.push([window(4791, '/p')]);
    await settle();
    expect(ch.wsOpens, hasLength(2));
  });

  group('permission mode', () {
    Map<String, Object?> caps() => {
      'compact': true,
      'clear': true,
      'modes': ['default', 'plan'],
      'usage': true,
      'fileSuggestions': true,
      'fork': false,
      'idleCompact': true,
      'models': true,
    };

    Future<void> open(Map<String, Object?> c) async {
      ch.event(ch.lastWsId, {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': c,
      });
      ch.event(ch.lastWsId, replay([]));
      await settle();
    }

    test(
      'a mode event sets the mode and notifies, also before the replay',
      () async {
        var n = 0;
        tab.addListener(() => n++);
        expect(tab.mode, isNull);
        ch.event(ch.lastWsId, {'kind': 'mode', 'mode': 'plan'});
        await settle();
        expect(tab.mode, AgentMode.plan);
        expect(n, greaterThan(0));
        ch.event(ch.lastWsId, replay([]));
        await settle();
        expect(tab.mode, AgentMode.plan);
        ch.event(ch.lastWsId, {'kind': 'mode', 'mode': 'default', 'ack': 'x'});
        await settle();
        expect(tab.mode, AgentMode.default_);
      },
    );

    test('setMode sends the id and leaves the mode until the event', () async {
      await open(caps());
      ch.event(ch.lastWsId, {'kind': 'mode', 'mode': 'default'});
      await settle();
      expect(tab.setMode(AgentMode.plan), isTrue);
      await settle();
      final m = ch.sentOn(ch.lastWsId).single;
      expect(m['type'], 'mode');
      expect(m['mode'], 'plan');
      expect(m['id'], matches(RegExp(r'^[0-9a-f-]{36}$')));
      expect(tab.mode, AgentMode.default_);
      ch.event(ch.lastWsId, {'kind': 'mode', 'mode': 'plan', 'ack': m['id']});
      await settle();
      expect(tab.mode, AgentMode.plan);
    });

    test('setMode on a window the tab does not own sends nothing', () async {
      expect(tab.setMode(AgentMode.plan), isFalse);
    });
  });
}
