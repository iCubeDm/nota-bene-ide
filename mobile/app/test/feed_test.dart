import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/feed.dart';
import 'package:nb_protocol/nb_protocol.dart';

ServerEvent ev(Map<String, Object?> j) => ServerEvent.fromJson(j);
Map<String, Object?> agent(Map<String, Object?> e) => {
  'kind': 'agent',
  'e': e,
  'ts': 1,
};
Feed run(List<Map<String, Object?>> events) {
  final f = Feed();
  for (final e in events) {
    f.apply(ev(e));
  }
  return f;
}

void main() {
  test('every server fixture applies without throwing', () {
    final doc =
        jsonDecode(
              File('../../shared/fixtures/protocol.json').readAsStringSync(),
            )
            as Map;
    final f = Feed();
    for (final e in (doc['server'] as List).cast<Map<String, Object?>>()) {
      f.apply(ev(e));
    }
  });

  test('replay builds a fresh feed', () {
    final f = run([
      {'kind': 'user', 'id': 'old', 'text': 'gone', 'ts': 1},
      {
        'kind': 'replay',
        'earlier': 2,
        'events': [
          {'kind': 'user', 'id': 'u1', 'text': 'hi', 'ts': 1, 'historic': true},
          agent({'t': 'message', 'id': 'a1', 'text': 'hello'}),
        ],
      },
    ]);
    expect(f.items.map((i) => i.runtimeType), [UserItem, AssistantItem]);
    expect((f.items[1] as AssistantItem).text, 'hello');
    expect(
      f.busy,
      isFalse,
      reason: 'a historic send does not make the feed busy',
    );
    expect(f.earlier, 2);
  });

  test('chunks stream into one assistant item and message finalizes it', () {
    final f = run([
      agent({'t': 'message-start'}),
      agent({'t': 'message-chunk', 'text': 'Hel'}),
      agent({'t': 'message-chunk', 'text': 'lo'}),
    ]);
    final a = f.items.single as AssistantItem;
    expect((a.text, a.final_), ('Hello', false));
    f.apply(ev(agent({'t': 'message', 'id': 'm1', 'text': 'Hello!'})));
    final b = f.items.single as AssistantItem;
    expect((b.id, b.text, b.final_), ('m1', 'Hello!', true));
  });

  test('tool-call shows the command as its arg and tool-update its result', () {
    final f = run([
      agent({
        't': 'tool-call',
        'id': 't1',
        'name': 'Bash',
        'input': {'command': 'npm test\nmore', 'description': 'x'},
        'sub': false,
      }),
      agent({
        't': 'tool-call',
        'id': 't2',
        'name': 'Read',
        'input': {'file_path': 'a' * 300},
        'sub': false,
      }),
      agent({'t': 'tool-update', 'id': 't1', 'text': 'ok', 'isError': false}),
    ]);
    final t1 = f.items[0] as ToolItem, t2 = f.items[1] as ToolItem;
    expect(t1.arg, 'npm test');
    expect(t1.result, 'ok');
    expect(t2.arg.length, 160);
  });

  test('turn-end clears busy unless queued or a send waits', () {
    final f = run([
      {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      {'kind': 'user', 'id': 'u2', 'text': 'next', 'ts': 2},
    ]);
    expect(f.busy, isTrue);
    f.apply(
      ev(
        agent({
          't': 'turn-end',
          'stop': 'done',
          'secs': 3,
          'answers': ['u1'],
          'queued': 0,
        }),
      ),
    );
    expect(f.busy, isTrue, reason: 'u2 is still waiting');
    expect(f.items.last, isA<DoneItem>());
    f.apply(
      ev(
        agent({
          't': 'turn-end',
          'stop': 'done',
          'secs': 1,
          'answers': ['u2'],
          'queued': 0,
        }),
      ),
    );
    expect(f.busy, isFalse);
  });

  test('an open stream at turn-end keeps its text, an empty one goes', () {
    final f = run([
      agent({'t': 'message-start'}),
      agent({'t': 'message-chunk', 'text': 'partial'}),
      agent({'t': 'message-start'}),
      agent({
        't': 'turn-end',
        'stop': 'interrupted',
        'secs': 1,
        'answers': 'all',
        'queued': 0,
      }),
    ]);
    expect(f.items.whereType<AssistantItem>().single.text, 'partial');
    expect(f.items.whereType<AssistantItem>().single.final_, isTrue);
    expect((f.items.last as DoneItem).status, StopReason.interrupted);
  });

  test('permission-done marks the card answered', () {
    final f = run([
      {
        'kind': 'permission',
        'id': 'p1',
        'toolName': 'Bash',
        'input': {'command': 'rm -rf build'},
        'ts': 1,
      },
      {'kind': 'permission-done', 'id': 'p1', 'allow': false, 'ts': 2},
    ]);
    final p = f.items.single as PermissionItem;
    expect((p.toolName, p.answer), ('Bash', false));
  });

  test('compaction leaves a marker, reset clears the feed', () {
    final f = run([
      {'kind': 'user', 'id': 'u1', 'text': 'x', 'ts': 1, 'historic': true},
      agent({'t': 'compacting'}),
    ]);
    expect(f.compacting, isTrue);
    f.apply(ev(agent({'t': 'compacted', 'preTokens': 120000})));
    expect(f.compacting, isFalse);
    expect((f.items.last as MarkerItem).what, MarkerKind.compacted);
    f.apply(ev(agent({'t': 'reset'})));
    expect((f.items.single as MarkerItem).what, MarkerKind.cleared);
  });

  test('the session event keeps title and model', () {
    final f = run([
      {
        'kind': 'session',
        'id': 's1',
        'root': '/p',
        'title': 'Plan',
        'model': 'opus',
      },
    ]);
    expect((f.title, f.model), ('Plan', 'opus'));
  });
}
