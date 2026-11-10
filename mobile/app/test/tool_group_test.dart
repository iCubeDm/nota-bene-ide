import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/feed.dart';
import 'package:nb_app/l10n/app_localizations.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/rig.dart';

ToolItem tool(String id, {String name = 'Bash', bool sub = false}) =>
    ToolItem(id, name, 'arg $id', const {}, sub: sub);

Map<String, Object?> call(
  String id, {
  String name = 'Bash',
  bool sub = false,
  String? kind,
}) => agent({
  't': 'tool-call',
  'id': id,
  'name': name,
  'input': {'command': 'cmd $id'},
  'sub': sub,
  'toolKind': ?kind,
});

Map<String, Object?> done(String id, {bool error = false, String? text}) =>
    agent({
      't': 'tool-update',
      'id': id,
      'text': text ?? 'out $id',
      'isError': error,
    });

Map<String, Object?> said(String id) =>
    agent({'t': 'message', 'id': id, 'text': 'Reply $id'});

void main() {
  group('feedRows, the web Feed.tsx rules', () {
    List<List<String>> rows(List<FeedItem> items) => [
      for (final r in feedRows(items)) [for (final i in r.items) feedKey(i)],
    ];

    test('consecutive actions, sub ones too, make one group', () {
      expect(rows([tool('a'), tool('b', sub: true), tool('c')]), [
        ['tool:a', 'tool:b', 'tool:c'],
      ]);
    });

    test('one action alone stays a plain line', () {
      final r = feedRows([tool('a')]);
      expect(r.single.isGroup, isFalse);
    });

    test(
      'a subagent call is a card of its own and ends the runs beside it',
      () {
        final items = [
          tool('a'),
          tool('b'),
          tool('t', name: 'Task'),
          tool('c'),
          tool('d'),
          tool('e', name: 'Other'),
        ];
        expect(rows(items), [
          ['tool:a', 'tool:b'],
          ['tool:t'],
          ['tool:c', 'tool:d', 'tool:e'],
        ]);
        expect(feedRows(items)[1].isGroup, isFalse);
      },
    );

    test('toolKind agent counts as a subagent call whatever its name', () {
      final a = ToolItem(
        'x',
        'Delegate',
        '',
        const {},
        sub: false,
        kind: WireAgentEventToolCallToolKind.agent,
      );
      expect(rows([tool('a'), a, tool('b')]), [
        ['tool:a'],
        ['tool:x'],
        ['tool:b'],
      ]);
    });

    test('text, a permission, a shell block or a line breaks a run', () {
      final items = <FeedItem>[
        tool('a'),
        tool('b'),
        AssistantItem('m', 'x', final_: true),
        tool('c'),
        tool('d'),
        PermissionItem('p', 'Bash', const {}, null),
        tool('e'),
        tool('f'),
      ];
      expect(rows(items).map((r) => r.length), [2, 1, 2, 1, 2]);
    });

    test('a group is keyed by its first action', () {
      expect(feedRows([tool('a'), tool('b')]).single.key, 'group:a');
      expect(feedRows([tool('a')]).single.key, 'tool:a');
    });
  });

  group('the head strings', () {
    test('plural forms', () async {
      final en = await AppLocalizations.delegate.load(const Locale('en'));
      expect(en.toolActions(1), '1 action');
      expect(en.toolActions(6), '6 actions');
      final ru = await AppLocalizations.delegate.load(const Locale('ru'));
      expect(ru.toolActions(1), '1 действие');
      expect(ru.toolActions(3), '3 действия');
      expect(ru.toolActions(5), '5 действий');
      expect(ru.toolErrors(21), '21 ошибка');
      expect(ru.toolComments(12), '12 комментариев');
      final de = await AppLocalizations.delegate.load(const Locale('de'));
      expect(de.toolComments(2), '2 Kommentare');
      final zh = await AppLocalizations.delegate.load(const Locale('zh'));
      expect(zh.toolErrors(2), '2 个错误');
    });
  });

  group('in the chat', () {
    late Rig r;
    setUp(() => r = Rig());
    tearDown(() => r.dispose());

    Future<void> open(
      WidgetTester t,
      List<Map<String, Object?>> events, {
      bool settle = true,
    }) async {
      t.view.physicalSize = const Size(400, 800);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await r.open(t, events: events, settle: settle);
    }

    testWidgets('folds into one head, the actions out of sight', (t) async {
      await open(t, [
        said('a1'),
        call('t1'),
        done('t1'),
        call('t2'),
        done('t2'),
        call('t3'),
        done('t3'),
      ]);
      expect(find.text('▸ 3 actions'), findsOneWidget);
      expect(find.text('cmd t1'), findsNothing);
      expect(find.text('Bash'), findsNothing);
    });

    testWidgets('one action alone is the plain line', (t) async {
      await open(t, [said('a1'), call('t1'), done('t1')]);
      expect(find.textContaining('actions'), findsNothing);
      expect(find.text('Bash'), findsOneWidget);
    });

    testWidgets('errors count in the danger colour', (t) async {
      await open(t, [
        call('t1'),
        done('t1'),
        call('t2'),
        done('t2', error: true),
        call('t3'),
        done('t3', error: true),
      ]);
      final c = Theme.of(
        t.element(find.byType(Scaffold).first),
      ).extension<NbColors>()!;
      final head = t.widget<Text>(find.byKey(const ValueKey('group-head')));
      final span = head.textSpan! as TextSpan;
      expect(span.toPlainText(), '▸ 3 actions · 2 errors');
      final err = span.children!.whereType<TextSpan>().firstWhere(
        (s) => (s.text ?? '').contains('errors'),
      );
      expect(err.style!.color, c.destructive);
    });

    testWidgets('a tap opens every line, another folds it again', (t) async {
      await open(t, [
        call('t1'),
        done('t1'),
        call('t2', sub: true),
        done('t2'),
        call('t3'),
        done('t3'),
      ]);
      await t.tap(find.text('▸ 3 actions'));
      await t.pumpAndSettle();
      expect(find.text('▾ 3 actions'), findsOneWidget);
      expect(find.text('cmd t1'), findsOneWidget);
      expect(find.text('cmd t2'), findsOneWidget);
      expect(find.text('cmd t3'), findsOneWidget);
      // a line still opens its output
      expect(find.text('out t1'), findsNothing);
      await t.tap(find.text('cmd t1'));
      await t.pumpAndSettle();
      expect(find.text('out t1'), findsOneWidget);
      await t.tap(find.text('▾ 3 actions'));
      await t.pumpAndSettle();
      expect(find.text('▸ 3 actions'), findsOneWidget);
      expect(find.text('cmd t1'), findsNothing);
    });

    testWidgets('a failed line of an open group opens by itself', (t) async {
      await open(t, [
        call('t1'),
        done('t1'),
        call('t2'),
        done('t2', error: true, text: 'boom'),
      ]);
      expect(find.text('boom'), findsNothing);
      await t.tap(find.text('▸ 2 actions · 1 error'));
      await t.pumpAndSettle();
      expect(find.text('boom'), findsOneWidget);
      expect(find.text('out t1'), findsNothing);
      // it can be folded by hand
      await t.tap(find.text('cmd t2'));
      await t.pumpAndSettle();
      expect(find.text('boom'), findsNothing);
    });

    testWidgets('while the turn runs the last group shows its latest action', (
      t,
    ) async {
      await open(t, [
        agent({'t': 'turn-start'}),
        call('t1'), done('t1'),
        call('t2'), // still running
      ], settle: false);
      expect(find.text('▸ 2 actions'), findsOneWidget);
      expect(find.text('cmd t2'), findsOneWidget);
      expect(find.text('cmd t1'), findsNothing);
      // open: the head, then every line (the latest not twice)
      await t.tap(find.text('▸ 2 actions'));
      await t.pump(const Duration(milliseconds: 100));
      expect(find.text('cmd t1'), findsOneWidget);
      expect(find.text('cmd t2'), findsOneWidget);
    });

    testWidgets('an earlier group, or a finished turn, shows no latest line', (
      t,
    ) async {
      await open(t, [
        call('t1'),
        done('t1'),
        call('t2'),
        done('t2'),
        said('a1'),
        call('t3'),
        done('t3'),
        call('t4'),
        done('t4'),
      ]);
      expect(find.text('▸ 2 actions'), findsNWidgets(2));
      expect(find.textContaining('cmd t'), findsNothing);
    });

    testWidgets('comments on its actions count in the folded head', (t) async {
      await open(t, [call('t1'), done('t1'), call('t2'), done('t2')]);
      Map<String, Object?> comment(String id, String tool) => {
        'id': id,
        'anchor': {
          'source': {'kind': 'message', 'id': 'tool:$tool'},
          'start': 0,
          'end': 3,
          'quote': 'out',
          'prefix': '',
          'suffix': '',
        },
        'text': 'why',
        'status': 'pending',
        'createdAt': 1,
      };
      r.event({
        'kind': 'comments',
        'items': [comment('c1', 't1'), comment('c2', 't2')],
      });
      await t.pumpAndSettle();
      expect(find.text('▸ 2 actions · 2 comments'), findsOneWidget);
      await t.tap(find.text('▸ 2 actions · 2 comments'));
      await t.pumpAndSettle();
      expect(find.text('▾ 2 actions'), findsOneWidget);
    });

    testWidgets('the open state survives scrolling away and back', (t) async {
      await open(t, [
        call('t1'),
        done('t1'),
        call('t2'),
        done('t2'),
        for (var i = 0; i < 30; i++) said('m$i'),
      ]);
      await t.drag(find.byType(ListView), const Offset(0, 100000));
      await t.pumpAndSettle();
      await t.tap(find.text('▸ 2 actions'));
      await t.pumpAndSettle();
      await t.tap(find.text('cmd t1'));
      await t.pumpAndSettle();
      expect(find.text('out t1'), findsOneWidget);
      await t.drag(find.byType(ListView), const Offset(0, -100000));
      await t.pumpAndSettle();
      expect(find.text('▾ 2 actions'), findsNothing);
      await t.drag(find.byType(ListView), const Offset(0, 100000));
      await t.pumpAndSettle();
      expect(find.text('▾ 2 actions'), findsOneWidget);
      expect(find.text('out t1'), findsOneWidget);
    });

    testWidgets('the state stays with the window when the chat is reopened', (
      t,
    ) async {
      await open(t, [call('t1'), done('t1'), call('t2'), done('t2')]);
      await t.tap(find.text('▸ 2 actions'));
      await t.pumpAndSettle();
      final tab = r.tab!;
      expect(tab.feedUi.groupOpen('t1'), isTrue);
      // a replay of the same session (a reconnect) keeps it
      r.event({
        'kind': 'replay',
        'events': [call('t1'), done('t1'), call('t2'), done('t2')],
      });
      await t.pumpAndSettle();
      expect(find.text('▾ 2 actions'), findsOneWidget);
    });
  });
}
