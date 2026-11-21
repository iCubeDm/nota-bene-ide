// The chat's background tasks (issue 573): the header's count, the sheet of tasks, Stop and To background, and the
// views a task opens (a subagent's conversation, a shell's output).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/rig.dart';

const session = {
  'kind': 'session',
  'id': 'sess-1',
  'root': '/home/u/notes',
  'title': 'Notes',
  'model': 'm',
};

Map<String, Object?> task(Map<String, Object?> e, {num? ts}) => {
  'kind': 'agent',
  'ts': ts ?? DateTime.now().millisecondsSinceEpoch,
  'e': {'t': 'task', ...e},
};

Map<String, Object?> started(
  String id, [
  Map<String, Object?> more = const {},
]) => task({
  'id': id,
  'phase': 'started',
  'desc': 'do $id',
  'type': 'local_agent',
  ...more,
});

Map<String, Object?> done(String id) => task({'id': id, 'phase': 'done'});

final indicator = find.byKey(const ValueKey('tasks-indicator'));
Finder row(String id) => find.byKey(ValueKey('task:$id'));

Future<void> openSheet(WidgetTester t) async {
  await t.tap(indicator);
  await t.pump();
  await t.pump(const Duration(milliseconds: 400));
}

void main() {
  testWidgets(
    'the header counts the running tasks, then the finished; none: no count',
    (t) async {
      final r = Rig();
      addTearDown(r.dispose);
      await r.open(t, events: [session]);
      expect(indicator, findsNothing);
      r.event(started('a', {'type': 'local_bash'}));
      r.event(started('b'));
      await t.pumpAndSettle();
      expect(
        find.descendant(of: indicator, matching: find.text('2 tasks')),
        findsOneWidget,
      );
      r.event(done('a'));
      r.event(done('b'));
      await t.pumpAndSettle();
      expect(
        find.descendant(of: indicator, matching: find.text('2')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'the sheet nests the tasks as the desktop does, with kind, description and elapsed time',
    (t) async {
      final r = Rig();
      addTearDown(r.dispose);
      await r.open(t, events: [session]);
      final t0 = DateTime.now().millisecondsSinceEpoch - 65000;
      r.event(started('p', {'call': 'toolu_p'}));
      r.event(
        started('k', {'parent': 'p', 'type': 'local_bash', 'desc': 'npm test'}),
      );
      r.event(started('a1', {'group': 'g', 'call': 'toolu_1'}));
      r.event(started('a2', {'group': 'g', 'call': 'toolu_2'}));
      r.event(
        task({
          'id': 'old',
          'phase': 'started',
          'desc': 'an old one',
          'type': 'local_bash',
        }, ts: t0),
      );
      r.event(task({'id': 'old', 'phase': 'done'}, ts: t0 + 65000));
      await t.pumpAndSettle();
      await openSheet(t);
      expect(find.text('npm test'), findsOneWidget);
      expect(find.text('2 parallel agents'), findsOneWidget);
      expect(find.textContaining('local_bash · 1:05'), findsOneWidget);
      // a child stands deeper than its parent
      expect(
        t.getTopLeft(find.text('npm test')).dx,
        greaterThan(t.getTopLeft(find.text('do p')).dx),
      );
      expect(
        t.getTopLeft(find.text('do a1')).dx,
        greaterThan(t.getTopLeft(find.text('2 parallel agents')).dx),
      );
    },
  );

  testWidgets(
    'Stop asks once more, sends, waits for its answer, and is offered again after a refusal',
    (t) async {
      final r = Rig();
      addTearDown(r.dispose);
      await r.open(t, events: [session]);
      r.event(started('s', {'type': 'local_bash'}));
      await t.pumpAndSettle();
      await openSheet(t);
      final stop = find.descendant(of: row('s'), matching: find.text('Stop'));
      await t.tap(stop);
      await t.pump();
      expect(
        find.descendant(of: row('s'), matching: find.text('Stop?')),
        findsOneWidget,
      );
      await t.tap(find.text('Stop?'));
      await t.pump();
      expect(r.sent.where((m) => m['type'] == 'task-stop').toList(), [
        {'type': 'task-stop', 'id': 's'},
      ]);
      expect(find.text('Stopping…'), findsOneWidget);
      r.event({
        'kind': 'server-error',
        'where': 'task',
        'message': 'no such task',
      });
      await t.pumpAndSettle();
      expect(
        find.descendant(of: row('s'), matching: find.text('Stop')),
        findsOneWidget,
      );
      // unconfirmed, it goes back by itself
      await t.tap(find.descendant(of: row('s'), matching: find.text('Stop')));
      await t.pump(const Duration(seconds: 4));
      expect(find.text('Stop?'), findsNothing);
    },
  );

  testWidgets('a swarm stops all its running agents', (t) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t, events: [session]);
    r.event(started('a1', {'group': 'g'}));
    r.event(started('a2', {'group': 'g'}));
    r.event(started('a3', {'group': 'g'}));
    r.event(done('a3'));
    await t.pumpAndSettle();
    await openSheet(t);
    await t.tap(find.text('Stop all'));
    await t.pump();
    await t.tap(find.text('Stop all?'));
    await t.pump();
    expect(r.sent.where((m) => m['type'] == 'task-stop').map((m) => m['id']), [
      'a1',
      'a2',
    ]);
  });

  testWidgets('To background moves a blocking task by its call', (t) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t, events: [session]);
    r.event(started('a', {'call': 'toolu_a', 'bg': false}));
    r.event(started('b', {'call': 'toolu_b', 'bg': true}));
    await t.pumpAndSettle();
    await openSheet(t);
    expect(
      find.descendant(of: row('b'), matching: find.text('To background')),
      findsNothing,
    );
    await t.tap(
      find.descendant(of: row('a'), matching: find.text('To background')),
    );
    await t.pump();
    expect(r.sent.where((m) => m['type'] == 'task-background').toList(), [
      {'type': 'task-background', 'toolUseId': 'toolu_a'},
    ]);
  });

  testWidgets(
    'a window before the task controls lists the tasks without Stop, Background or a view',
    (t) async {
      final r = Rig();
      addTearDown(r.dispose);
      await r.open(
        t,
        events: [session],
        hello: {'kind': 'hello', 'protocol': 6, 'capabilities': Rig.caps()},
      );
      r.event(started('a', {'call': 'toolu_a', 'bg': false}));
      r.event(started('s', {'type': 'local_bash'}));
      await t.pumpAndSettle();
      await openSheet(t);
      expect(row('a'), findsOneWidget);
      expect(find.text('Stop'), findsNothing);
      expect(find.text('To background'), findsNothing);
      await t.tap(row('s'));
      await t.pump(const Duration(milliseconds: 400));
      expect(r.ch.requests, isEmpty);
    },
  );

  testWidgets('a window without To background has none', (t) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(
      t,
      events: [session],
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': {...Rig.caps(), 'taskBackground': false},
      },
    );
    r.event(started('a', {'call': 'toolu_a', 'bg': false}));
    await t.pumpAndSettle();
    await openSheet(t);
    expect(find.text('Stop'), findsOneWidget);
    expect(find.text('To background'), findsNothing);
  });

  testWidgets('a shell opens its output, plain, read again while it runs', (
    t,
  ) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t, events: [session]);
    var running = true;
    r.ch.onHttp = (port, method, path) async => answer(
      200,
      jsonEncode({
        'output': '\u001b[32mok\u001b[0m line\n',
        'totalBytes': 13,
        'truncated': false,
        'running': running,
      }),
    );
    r.event(started('s', {'type': 'local_bash', 'desc': 'npm test'}));
    await t.pumpAndSettle();
    await openSheet(t);
    await t.tap(row('s'));
    await t.pumpAndSettle();
    expect(r.ch.requests, ['GET /task-output?session=sess-1&task=s']);
    expect(find.text('ok line\n'), findsOneWidget);
    await t.pump(const Duration(milliseconds: 1100));
    expect(r.ch.requests.length, 2);
    running = false;
    await t.pump(const Duration(milliseconds: 1100));
    await t.pump(const Duration(milliseconds: 3000));
    expect(
      r.ch.requests.length,
      3,
      reason: 'the read that saw it end is the last',
    );
  });

  testWidgets('a shell the window no longer knows says so', (t) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t, events: [session]);
    r.ch.onHttp = (port, method, path) async => answer(404, '');
    r.event(started('s', {'type': 'local_bash'}));
    await t.pumpAndSettle();
    await openSheet(t);
    await t.tap(row('s'));
    await t.pumpAndSettle();
    expect(find.textContaining('no longer knows this task'), findsOneWidget);
  });

  testWidgets(
    'a subagent opens its conversation, read-only, polled while it works and on screen',
    (t) async {
      final r = Rig();
      addTearDown(r.dispose);
      await r.open(t, events: [session]);
      var running = true;
      r.ch.onHttp = (port, method, path) async => answer(
        200,
        jsonEncode({
          'events': [
            {'kind': 'user', 'id': 'u1', 'text': 'look around', 'ts': 1},
            {
              'kind': 'agent',
              'ts': 2,
              'e': {'t': 'message', 'id': 'm:0', 'text': 'found the thing'},
            },
          ],
          'running': running,
          'type': 'Explore',
          'description': 'look around the code',
        }),
      );
      r.event(started('a', {'call': 'toolu_a'}));
      await t.pumpAndSettle();
      await openSheet(t);
      await t.tap(row('a'));
      await t.pumpAndSettle();
      expect(r.ch.requests, ['GET /subagent?session=sess-1&tool=toolu_a']);
      expect(find.text('look around the code'), findsOneWidget);
      expect(find.textContaining('found the thing'), findsOneWidget);
      expect(find.byType(TextField), findsNothing, reason: 'read-only');
      await t.pump(const Duration(milliseconds: 1600));
      expect(r.ch.requests.length, 2);
      // gone from the screen: no more reads
      await t.pageBack();
      await t.pumpAndSettle();
      final n = r.ch.requests.length;
      await t.pump(const Duration(seconds: 5));
      expect(r.ch.requests.length, n);
      running = false;
    },
  );

  testWidgets('a subagent that finished is read once', (t) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t, events: [session]);
    r.ch.onHttp = (port, method, path) async => answer(
      200,
      jsonEncode({
        'events': <Object>[],
        'running': false,
        'type': 'Explore',
        'description': 'd',
      }),
    );
    r.event(started('a', {'call': 'toolu_a'}));
    r.event(done('a'));
    await t.pumpAndSettle();
    await openSheet(t);
    await t.tap(row('a'));
    await t.pumpAndSettle();
    await t.pump(const Duration(seconds: 5));
    expect(r.ch.requests.length, 1);
  });

  testWidgets('an open subagent that runs again (a resume) is read again', (
    t,
  ) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t, events: [session]);
    var running = false;
    r.ch.onHttp = (port, method, path) async => answer(
      200,
      jsonEncode({
        'events': <Object>[],
        'running': running,
        'type': 'Explore',
        'description': 'd',
      }),
    );
    r.event(started('a', {'call': 'toolu_a'}));
    r.event(done('a'));
    await t.pumpAndSettle();
    await openSheet(t);
    await t.tap(row('a'));
    await t.pumpAndSettle();
    await t.pump(const Duration(seconds: 3));
    expect(r.ch.requests.length, 1);
    running = true;
    r.event(started('a', {'call': 'toolu_resume'}));
    await t.pumpAndSettle();
    expect(r.ch.requests.length, 2);
    await t.pump(const Duration(milliseconds: 1600));
    expect(r.ch.requests.length, 3);
    running = false;
    await t.pump(const Duration(milliseconds: 1600));
  });

  testWidgets('an answer that cannot be read is said, not left loading', (
    t,
  ) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t, events: [session]);
    r.ch.onHttp = (port, method, path) async =>
        answer(200, jsonEncode({'events': 3, 'output': 1}));
    r.event(started('a', {'call': 'toolu_a'}));
    r.event(started('s', {'type': 'local_bash'}));
    await t.pumpAndSettle();
    await openSheet(t);
    await t.tap(row('a'));
    await t.pumpAndSettle();
    expect(find.textContaining('Could not load the subagent'), findsOneWidget);
    await t.pageBack();
    await t.pumpAndSettle();
    await openSheet(t);
    await t.tap(row('s'));
    await t.pumpAndSettle();
    expect(find.textContaining('Could not read the output'), findsOneWidget);
  });

  testWidgets(
    'a read waits out a brief inactive app and goes on when it returns',
    (t) async {
      final r = Rig();
      addTearDown(r.dispose);
      await r.open(t, events: [session]);
      r.ch.onHttp = (port, method, path) async => answer(
        200,
        jsonEncode({
          'output': 'x',
          'totalBytes': 1,
          'truncated': false,
          'running': true,
        }),
      );
      r.event(started('s', {'type': 'local_bash'}));
      await t.pumpAndSettle();
      await openSheet(t);
      await t.tap(row('s'));
      await t.pumpAndSettle();
      final n = r.ch.requests.length;
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await t.pump(const Duration(milliseconds: 1100));
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pump(const Duration(milliseconds: 1100));
      await t.pump(const Duration(milliseconds: 1100));
      expect(r.ch.requests.length, greaterThanOrEqualTo(n + 2));
      await t.pageBack();
      await t.pumpAndSettle();
    },
  );
}
