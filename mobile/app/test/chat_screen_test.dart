import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_screen.dart';
import 'package:nb_app/chat/mermaid.dart';
import 'package:nb_app/chat/window_tab.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';
import 'support/mermaid_fake.dart';

Map<String, Object?> agent(Map<String, Object?> e) => {
  'kind': 'agent',
  'e': e,
  'ts': 1,
};

void main() {
  late FakeChannel ch;
  late HostLink link;
  late WindowTab tab;

  Future<void> open(WidgetTester t) async {
    final f = FakeFactory();
    ch = FakeChannel([window(4791, '/home/u/notes')]);
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
    await t.pump();
    tab = WindowTab(link, 4791, '/home/u/notes', retry: (_) async {});
    await t.pumpWidget(
      NbApp(
        home: MermaidScope(
          renderer: FakeMermaid(),
          child: ChatScreen(tab: tab),
        ),
      ),
    );
    await t.pump();
  }

  tearDown(() {
    tab.dispose();
    link.dispose();
  });

  testWidgets('the feed shows user, assistant, tool and done items', (t) async {
    await open(t);
    ch.event(ch.lastWsId, {
      'kind': 'replay',
      'events': [
        {
          'kind': 'user',
          'id': 'u1',
          'text': 'Run the tests',
          'ts': 1,
          'historic': true,
        },
        agent({
          't': 'tool-call',
          'id': 't1',
          'name': 'Bash',
          'input': {'command': 'npm test'},
          'sub': false,
        }),
        agent({
          't': 'tool-update',
          'id': 't1',
          'text': '42 passed',
          'isError': false,
        }),
        agent({'t': 'message', 'id': 'a1', 'text': 'All **green**.'}),
        agent({
          't': 'turn-end',
          'stop': 'done',
          'secs': 12,
          'answers': 'all',
          'queued': 0,
        }),
      ],
    });
    await t.pumpAndSettle();
    expect(find.text('Run the tests'), findsOneWidget);
    expect(find.textContaining('npm test'), findsOneWidget);
    expect(find.textContaining('green'), findsOneWidget);
    expect(find.textContaining('12 s'), findsOneWidget);
    expect(find.text('42 passed'), findsNothing);
    await t.tap(find.textContaining('npm test'));
    await t.pumpAndSettle();
    expect(
      find.text('42 passed'),
      findsOneWidget,
      reason: 'the result opens on tap',
    );
  });

  testWidgets('a streaming reply grows in place', (t) async {
    await open(t);
    ch.event(ch.lastWsId, {'kind': 'replay', 'events': []});
    ch.event(ch.lastWsId, agent({'t': 'message-start'}));
    ch.event(
      ch.lastWsId,
      agent({'t': 'message-chunk', 'text': 'Thinking about'}),
    );
    await t.pumpAndSettle();
    expect(find.textContaining('Thinking about'), findsOneWidget);
    ch.event(ch.lastWsId, agent({'t': 'message-chunk', 'text': ' it'}));
    await t.pumpAndSettle();
    expect(find.textContaining('Thinking about it'), findsOneWidget);
  });

  testWidgets('the title bar names the folder and the session', (t) async {
    await open(t);
    ch.event(ch.lastWsId, {'kind': 'replay', 'events': []});
    ch.event(ch.lastWsId, {
      'kind': 'session',
      'id': 's',
      'root': '/home/u/notes',
      'title': 'Spec work',
      'model': 'opus',
    });
    await t.pumpAndSettle();
    expect(find.text('notes'), findsOneWidget);
    expect(find.textContaining('Spec work'), findsOneWidget);
  });

  testWidgets(
    'an opened tool result stays with its tool when new items arrive',
    (t) async {
      await open(t);
      ch.event(ch.lastWsId, {
        'kind': 'replay',
        'events': [
          agent({
            't': 'tool-call',
            'id': 't1',
            'name': 'Bash',
            'input': {'command': 'first'},
            'sub': false,
          }),
          agent({
            't': 'tool-update',
            'id': 't1',
            'text': 'first out',
            'isError': false,
          }),
          agent({
            't': 'tool-call',
            'id': 't2',
            'name': 'Bash',
            'input': {'command': 'second'},
            'sub': false,
          }),
          agent({
            't': 'tool-update',
            'id': 't2',
            'text': 'second out',
            'isError': false,
          }),
        ],
      });
      await t.pumpAndSettle();
      await t.tap(find.textContaining('first'));
      await t.pumpAndSettle();
      expect(find.text('first out'), findsOneWidget);
      ch.event(
        ch.lastWsId,
        agent({
          't': 'tool-call',
          'id': 't3',
          'name': 'Bash',
          'input': {'command': 'third'},
          'sub': false,
        }),
      );
      await t.pumpAndSettle();
      expect(find.text('first out'), findsOneWidget);
      expect(find.text('second out'), findsNothing);
    },
  );
}
