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

  test('an earlier page goes before the feed, once', () {
    final f = run([
      {
        'kind': 'replay',
        'earlier': 2,
        'events': [
          {
            'kind': 'user',
            'id': 'u3',
            'text': 'now',
            'ts': 3,
            'historic': true,
          },
        ],
      },
    ]);
    f.prepend(
      [
        ev({
          'kind': 'user',
          'id': 'u1',
          'text': 'long ago',
          'ts': 1,
          'historic': true,
        }),
        ev({
          'kind': 'permission',
          'id': 'p0',
          'toolName': 'Bash',
          'input': {'command': 'x'},
          'ts': 1,
        }),
        ev({
          'kind': 'user',
          'id': 'u3',
          'text': 'now',
          'ts': 3,
          'historic': true,
        }),
      ],
      segment: 2,
      more: true,
      epoch: f.epoch,
    );
    expect(
      [
        for (final i in f.items)
          i is UserItem ? i.id : (i as PermissionItem).id,
      ],
      ['u1', 'p0', 'u3'],
    );
    expect(
      (f.items[1] as PermissionItem).archived,
      isTrue,
      reason: 'nobody waits for an archived ask',
    );
    expect(f.earlier, 1);
    f.prepend(
      [
        ev({
          'kind': 'user',
          'id': 'u0',
          'text': 'older',
          'ts': 0,
          'historic': true,
        }),
      ],
      segment: 5,
      more: false,
      epoch: f.epoch,
    );
    expect(
      f.items.first,
      isNot(isA<UserItem>().having((u) => u.id, 'id', 'u0')),
      reason: 'a page newer than earlier is not ours',
    );
    f.prepend(
      [
        ev({
          'kind': 'user',
          'id': 'u0',
          'text': 'older',
          'ts': 0,
          'historic': true,
        }),
      ],
      segment: 1,
      more: false,
      epoch: f.epoch,
    );
    expect((f.items.first as UserItem).id, 'u0');
    expect(f.earlier, 0);
  });

  test('a page asked under an older replay is dropped', () {
    final f = run([
      {'kind': 'replay', 'earlier': 3, 'events': []},
    ]);
    final epoch = f.epoch;
    f.apply(ev({'kind': 'replay', 'earlier': 4, 'events': []}));
    f.prepend(
      [
        ev({'kind': 'user', 'id': 'x', 'text': 'x', 'ts': 1, 'historic': true}),
      ],
      segment: 3,
      more: true,
      epoch: epoch,
    );
    expect(f.items, isEmpty);
    expect(f.earlier, 4);
  });

  test('a live item also in the page moves to the page position', () {
    final f = run([
      {
        'kind': 'replay',
        'earlier': 1,
        'events': [
          {
            'kind': 'user',
            'id': 'q',
            'text': 'queued',
            'ts': 1,
            'historic': true,
          },
          agent({'t': 'message', 'id': 'a2', 'text': 'later reply'}),
        ],
      },
    ]);
    f.prepend(
      [
        ev({
          'kind': 'user',
          'id': 'q',
          'text': 'queued',
          'ts': 1,
          'historic': true,
        }),
        ev(agent({'t': 'message', 'id': 'a1', 'text': 'its reply'})),
      ],
      segment: 1,
      more: false,
      epoch: f.epoch,
    );
    expect(
      [for (final i in f.items) i is UserItem ? i.id : (i as AssistantItem).id],
      ['q', 'a1', 'a2'],
    );
  });

  group('voice', () {
    final voice = {'id': 'a' * 64, 'ms': 4000, 'wave': List.filled(48, 3)};
    Map<String, Object?> user(String id, {Object? v, String text = ''}) => {
      'kind': 'user',
      'id': id,
      'text': text,
      'voice': ?v,
      'ts': 1,
    };
    Map<String, Object?> said(String id, {String? text, String? error}) => {
      'kind': 'voice-text',
      'id': id,
      'text': ?text,
      'error': ?error,
      'ts': 2,
    };

    test('a voice message is an item with its voice and no text yet', () {
      final f = run([user('u1', v: voice)]);
      final u = f.items.single as UserItem;
      expect((u.voice!.id, u.shownText, u.transcribing), ('a' * 64, '', true));
      expect(f.busy, isTrue);
      expect(f.waiting, ['u1']);
    });

    test('voice-text puts the transcript or the error into its message', () {
      var f = run([user('u1', v: voice), said('u1', text: 'fix it')]);
      var u = f.items.single as UserItem;
      expect(
        (u.shownText, u.transcribing, u.voiceError),
        ('fix it', false, null),
      );
      f = run([user('u1', v: voice), said('u1', error: 'off')]);
      u = f.items.single as UserItem;
      expect((u.voiceError, u.transcribing), (VoiceError.off, false));
      // a voice-text for a message that is not here changes nothing
      expect(run([said('zz', text: 'x')]).items, isEmpty);
    });

    test('in a replay the transcript is the text, or comes as voice-text', () {
      final f = run([
        {
          'kind': 'replay',
          'events': [
            {...user('u1', v: voice, text: 'from history'), 'historic': true},
            {...user('u2', v: voice), 'historic': true},
            said('u2', text: 'stored'),
          ],
        },
      ]);
      expect(
        [for (final u in f.items.cast<UserItem>()) u.shownText],
        ['from history', 'stored'],
      );
    });

    test('a failed voice message is hidden once a later one has its voice', () {
      final f = run([
        user('u1', v: voice),
        said('u1', error: 'failed'),
        user('u2', v: voice),
      ]);
      expect([for (final u in f.items.cast<UserItem>()) u.id], ['u2']);
      // another voice does not hide it
      final g = run([
        user('u1', v: voice),
        said('u1', error: 'failed'),
        user('u2', v: {...voice, 'id': 'b' * 64}),
      ]);
      expect(g.items, hasLength(2));
    });

    test('the failure that comes after the retry hides it as well', () {
      final f = run([
        user('u1', v: voice),
        user('u2', v: voice),
        said('u1', error: 'failed'),
      ]);
      expect([for (final u in f.items.cast<UserItem>()) u.id], ['u2']);
    });
  });
}
