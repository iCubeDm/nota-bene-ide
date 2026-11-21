// The phone's tasks (issue 573) against the desktop's: web/src/plugins/tasks/mobileParity.test.ts writes the fixtures.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/feed.dart';
import 'package:nb_app/tasks/ansi.dart';
import 'package:nb_app/tasks/tasks.dart';
import 'package:nb_protocol/nb_protocol.dart';

ServerEvent ev(Map<String, Object?> j) => ServerEvent.fromJson(j);

Map<String, Object?> task(Map<String, Object?> e, {num ts = 1}) => {
  'kind': 'agent',
  'ts': ts,
  'e': {'t': 'task', ...e},
};

Object? rowJson(TaskRow r) => {
  'id': r.id,
  'depth': r.depth,
  if (r.group case final g?) 'group': g.toJson(),
};

void main() {
  final cases =
      Directory('test/fixtures/tasks')
          .listSync()
          .whereType<File>()
          .where((f) => !f.path.endsWith('text.json'))
          .toList()
        ..sort((a, b) => a.path.compareTo(b.path));
  test('has the desktop tasks fixtures', () {
    // as many as web/src/plugins/tasks/mobileParity.test.ts writes (it fails on a file no case produces)
    expect(cases.length, 8);
  });
  for (final file in cases) {
    test('the tasks of ${file.uri.pathSegments.last} match the desktop', () {
      final doc = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
      TasksState s = const {};
      for (final e in (doc['events'] as List).cast<Map<String, Object?>>()) {
        s = reduceTasks(s, ev(e));
      }
      expect({
        for (final e in s.entries) e.key: e.value.toJson(),
      }, doc['tasks']);
      expect([for (final e in orderedTasks(s)) e.key], doc['ordered']);
      expect([for (final r in taskRows(s)) rowJson(r)], doc['rows']);
      expect({
        'running': runningCount(s),
        'finished': finishedCount(s),
        'watchers': watcherCount(s),
      }, doc['counts']);
    });
  }

  final text =
      jsonDecode(File('test/fixtures/tasks/text.json').readAsStringSync())
          as Map<String, Object?>;
  test('a shell\'s output reads as the desktop shows it', () {
    for (final c in (text['plain'] as List).cast<Map<String, Object?>>()) {
      expect(
        plainOutput(c['raw'] as String, truncated: c['truncated'] as bool),
        c['text'],
        reason: jsonEncode(c['raw']),
      );
    }
  });
  test('the elapsed time reads as the desktop\'s', () {
    for (final c in (text['elapsed'] as List).cast<Map<String, Object?>>()) {
      expect(fmtElapsed(c['ms'] as num), c['text']);
    }
  });

  test('a model reads short, as the desktop names it', () {
    expect(shortModel('claude-sonnet-5-5'), 'Sonnet 5.5');
    expect(shortModel('claude-opus-5-5-20260101[1m]'), 'Opus 5.5');
    expect(shortModel('claude-haiku-5'), 'Haiku 5');
    expect(shortModel('sonnet'), 'Sonnet');
    expect(shortModel('gpt-5.5'), 'gpt-5.5');
  });

  group('Tasks', () {
    test('tells its listeners only when the tasks change', () {
      final t = Tasks();
      addTearDown(t.dispose);
      var n = 0;
      t.addListener(() => n++);
      t.apply(
        ev({
          'kind': 'agent',
          'ts': 1,
          'e': {'t': 'message-chunk', 'text': 'x'},
        }),
      );
      expect(n, 0);
      t.apply(ev(task({'id': 'a', 'phase': 'started', 'type': 'local_bash'})));
      expect(n, 1);
      t.apply(ev(task({'id': 'zz', 'phase': 'progress'})));
      expect(n, 1);
      t.apply(ev({'kind': 'server-error', 'where': 'task', 'message': 'no'}));
      expect((n, t.refusals), (2, 1));
      t.apply(ev({'kind': 'server-error', 'where': 'send', 'message': 'no'}));
      expect(n, 2);
    });

    test(
      'the elapsed time runs on the window\'s clock, read from its live events',
      () {
        var now = DateTime.fromMillisecondsSinceEpoch(500000);
        final t = Tasks()..clock = () => now;
        addTearDown(t.dispose);
        // the computer is 100 s behind the phone
        t.apply(ev(task({'id': 'a', 'phase': 'started'}, ts: 400000)));
        now = now.add(const Duration(seconds: 7));
        expect(t.now() - t.state['a']!.start, 7000);
      },
    );
  });

  group('foreground', () {
    Task run(Map<String, Object?> e) => reduceTasks(
      const {},
      ev(task({'id': 'a', 'phase': 'started', ...e})),
    )['a']!;
    test('the CLI\'s word holds', () {
      final f = Feed();
      expect(foreground(run({'call': 'c', 'bg': false}), f), isTrue);
      expect(foreground(run({'call': 'c', 'bg': true}), f), isFalse);
      expect(foreground(run({'bg': false}), f), isFalse, reason: 'no call');
    });
    test(
      'unsaid: a call with no result yet, of a subagent or while the turn runs',
      () {
        final f = Feed();
        expect(foreground(run({'call': 'c'}), f), isFalse);
        expect(foreground(run({'call': 'c', 'parent': 'p'}), f), isTrue);
        f.busy = true;
        expect(foreground(run({'call': 'c'}), f), isTrue);
        f.apply(
          ev({
            'kind': 'agent',
            'ts': 1,
            'e': {
              't': 'tool-call',
              'id': 'c',
              'name': 'Agent',
              'input': <String, Object?>{},
              'sub': false,
            },
          }),
        );
        f.apply(
          ev({
            'kind': 'agent',
            'ts': 1,
            'e': {
              't': 'tool-update',
              'id': 'c',
              'text': 'launched',
              'isError': false,
            },
          }),
        );
        f.busy = true;
        expect(foreground(run({'call': 'c'}), f), isFalse);
      },
    );
  });
}
