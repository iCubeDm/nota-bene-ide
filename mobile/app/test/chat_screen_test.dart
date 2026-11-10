import 'dart:async';

import 'package:flutter/material.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_screen.dart';
import 'package:nb_app/chat/mermaid.dart';
import 'package:nb_app/chat/window_tab.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_app/theme.dart';

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

  Future<void> open(WidgetTester t, {ChatFocus? focus}) async {
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
          child: ChatScreen(tab: tab, focus: focus),
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
    // a turn that ended well leaves no line: the header says when it was done
    expect(find.textContaining('12 s'), findsNothing);
    expect(find.text('42 passed'), findsNothing);
    await t.tap(find.textContaining('npm test'));
    await t.pumpAndSettle();
    expect(
      find.text('42 passed'),
      findsOneWidget,
      reason: 'the result opens on tap',
    );
  });

  testWidgets('a user message is a bubble, an assistant one is not', (t) async {
    await open(t);
    ch.event(ch.lastWsId, {
      'kind': 'replay',
      'events': [
        {'kind': 'user', 'id': 'u1', 'text': 'Hello there', 'ts': 1},
        agent({'t': 'message', 'id': 'a1', 'text': 'Hi back'}),
      ],
    });
    await t.pumpAndSettle();
    final c = Theme.of(
      t.element(find.text('Hello there')),
    ).extension<NbColors>()!;
    final bubble = find.byKey(const ValueKey('bubble'));
    expect(bubble, findsOneWidget);
    expect(
      find.descendant(of: bubble, matching: find.text('Hello there')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: bubble, matching: find.textContaining('Hi back')),
      findsNothing,
    );
    final d = (t.widget<Container>(bubble)).decoration! as BoxDecoration;
    expect(
      d.color,
      Color.alphaBlend(c.primary.withValues(alpha: .28), c.background),
    );
    final r = d.borderRadius! as BorderRadius;
    expect(r.bottomRight, const Radius.circular(4));
    expect(r.topLeft, const Radius.circular(14));
    expect(r.topRight, const Radius.circular(14));
    expect(r.bottomLeft, const Radius.circular(14));
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

  testWidgets('the header pill names the session, not the model', (t) async {
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
    expect(find.text('Spec work'), findsOneWidget);
    expect(find.text('opus'), findsNothing);
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
      await t.tap(find.text('▸ 2 actions'));
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

  testWidgets('scrolling to an item that is already built finds it', (t) async {
    final focus = ChatFocus();
    await open(t, focus: focus);
    ch.event(ch.lastWsId, {
      'kind': 'replay',
      'events': [
        for (var i = 0; i < 3; i++)
          {
            'kind': 'user',
            'id': 'u$i',
            'text': 'message $i',
            'ts': 1,
            'historic': true,
          },
      ],
    });
    await t.pumpAndSettle();
    bool? found;
    unawaited(focus.scrollTo('u1').then((v) => found = v));
    for (var i = 0; i < 20; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
    expect(found, isTrue);
  });
  testWidgets('a jump to an action in a folded group opens the group', (
    t,
  ) async {
    final focus = ChatFocus();
    await open(t, focus: focus);
    Map<String, Object?> call(String id) => agent({
      't': 'tool-call',
      'id': id,
      'name': 'Bash',
      'input': {'command': 'cmd $id'},
      'sub': false,
    });
    ch.event(ch.lastWsId, {
      'kind': 'replay',
      'events': [
        call('t1'),
        call('t2'),
        for (var i = 0; i < 20; i++)
          agent({'t': 'message', 'id': 'm$i', 'text': 'reply $i'}),
      ],
    });
    await t.pumpAndSettle();
    expect(find.text('cmd t2'), findsNothing);
    bool? found;
    unawaited(focus.scrollTo('tool:t2').then((v) => found = v));
    for (var i = 0; i < 30; i++) {
      await t.pump(const Duration(milliseconds: 100));
    }
    expect(found, isTrue);
    expect(find.text('cmd t2'), findsOneWidget);
  });
}
