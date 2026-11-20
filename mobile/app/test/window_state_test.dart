// What a window said, on its own (issue 511): [WindowState.apply] over event sequences, without a socket.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/feed.dart';
import 'package:nb_app/chat/window_state.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'feed_test.dart' show project, run;
import 'support/fakes.dart' show answer;

ServerEvent ev(Map<String, Object?> j) => ServerEvent.fromJson(j);

void main() {
  late List<ClientMessage> sent;
  late bool takes;
  late WindowState s;
  late int notified;

  setUp(() {
    sent = [];
    takes = true;
    notified = 0;
    s = WindowState(
      send: (m) {
        if (!takes) return false;
        sent.add(m);
        return true;
      },
      http: () => null,
    )..addListener(() => notified++);
  });

  tearDown(() => s.dispose());

  void apply(List<Map<String, Object?>> events) {
    for (final e in events) {
      s.apply(ev(e));
    }
  }

  test('the feed fixtures come out as the bare feed has them', () {
    final files = Directory(
      'test/fixtures/feed',
    ).listSync().whereType<File>().toList();
    expect(files, isNotEmpty);
    for (final file in files) {
      final doc = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
      final events = (doc['events'] as List).cast<Map<String, Object?>>();
      final st = WindowState(send: (_) => false, http: () => null);
      for (final e in events) {
        st.apply(ev(e));
      }
      expect(
        st.feed.items.map(project).toList(),
        run(events).items.map(project).toList(),
        reason: file.path,
      );
      st.dispose();
    }
  });

  test('every event notifies, the ones kept off the feed included', () {
    apply([
      {'kind': 'occupied'},
      {'kind': 'comment-ack', 'opId': 'o'},
      {'kind': 'send-held', 'id': 'h'},
    ]);
    expect(notified, 3);
    expect(s.feed.items, isEmpty);
  });

  test('hello, models, mode, model and stats are kept', () {
    apply([
      {
        'kind': 'hello',
        'protocol': 27,
        'tmpDirs': ['/tmp/x/', 'rel', '/'],
      },
      {
        'kind': 'models',
        'models': [
          {'value': 'opus', 'name': 'Opus', 'description': 'd'},
        ],
      },
      {'kind': 'mode', 'mode': 'plan'},
      {'kind': 'model', 'model': 'opus', 'effort': 'high'},
    ]);
    expect(s.tmpDirs, ['/tmp/x']);
    expect(s.models.single.value, 'opus');
    expect(s.mode, AgentMode.plan);
    expect((s.model, s.effort), ('opus', AgentEffort.high));
  });

  test(
    'held sends and a pending compaction: kept, waited on, gone with the socket',
    () {
      apply([
        {
          'kind': 'compact-pending',
          'pending': true,
          'held': [
            {'id': 'h1', 'text': 'a', 'ts': 1},
          ],
        },
        {'kind': 'restart-pending', 'pending': true},
      ]);
      expect(s.compactPending, isTrue);
      expect(s.held.single.id, 'h1');
      expect(s.restartPending, isTrue);
      expect(s.orderWaits, isTrue);
      apply([
        {'kind': 'compact-pending', 'pending': false, 'held': <Object?>[]},
      ]);
      expect(s.orderWaits, isFalse);
      expect(s.restartPending, isTrue);
      s.whisperOn = true;
      s.socket();
      expect(
        (s.restartPending, s.compactPending, s.held, s.whisperOn),
        (false, false, const <HeldSend>[], null),
      );
    },
  );

  test('busy since the first working event; the turn end times the done', () {
    var now = DateTime(2026, 1, 1, 12);
    s.clock = () => now;
    apply([
      {'kind': 'replay', 'events': <Object?>[]},
      {'kind': 'user', 'id': 'u', 'text': 'go', 'ts': 1},
    ]);
    expect(s.busy, isTrue);
    expect(s.busySince, now);
    now = now.add(const Duration(minutes: 1));
    apply([
      {
        'kind': 'agent',
        'ts': 2,
        'e': {
          't': 'turn-end',
          'stop': 'done',
          'secs': 1,
          'answers': 'all',
          'queued': 0,
        },
      },
    ]);
    expect(s.busy, isFalse);
    expect(s.busySince, isNull);
    expect(s.lastDoneAt, now);
  });

  test('a refusal and a server error go to their streams', () async {
    final refused = s.refusals.first;
    final error = s.errors.first;
    apply([
      {'kind': 'send-refused', 'id': 's1', 'reason': 'busy'},
      {'kind': 'server-error', 'where': 'send', 'message': 'm'},
    ]);
    expect((await refused).id, 's1');
    expect((await error).message, 'm');
  });

  test('Whisper switched off since the hello', () {
    apply([
      {'kind': 'voice-text', 'id': 'u', 'error': 'off', 'ts': 1},
    ]);
    expect(s.whisperOn, isFalse);
  });

  test('setMode and the idle compaction go through the send', () {
    expect(s.toggleIdleCompact(), isFalse, reason: 'no state yet');
    apply([
      {
        'kind': 'idle-compact',
        'state': {
          'on': false,
          'blocked': false,
          'minutes': 5,
          'awayMinutes': 10,
          'minTokens': 1,
        },
      },
    ]);
    expect(s.toggleIdleCompact(), isTrue);
    expect(s.idleCompact!.on, isTrue, reason: 'shown at once');
    expect(s.setMode(AgentMode.plan), isTrue);
    expect(s.mode, isNull, reason: 'until the mode event');
    expect(sent.map((m) => m.toJson()['type']), ['idle-compact', 'mode']);
    takes = false;
    expect(s.toggleIdleCompact(), isFalse);
    expect(s.idleCompact!.on, isTrue);
  });

  test(
    'loadEarlier asks the history before the feed and prepends it',
    () async {
      final asked = <String>[];
      final st = WindowState(
        send: (_) => false,
        http: () => (method, path, {headers, body}) async {
          asked.add('$method $path');
          return answer(
            200,
            jsonEncode({
              'events': [
                {
                  'kind': 'user',
                  'id': 'old',
                  'text': 'old',
                  'ts': 1,
                  'historic': true,
                },
              ],
              'segment': 0,
              'more': false,
            }),
          );
        },
      );
      st.apply(
        ev({
          'kind': 'replay',
          'earlier': 1,
          'events': [
            {
              'kind': 'user',
              'id': 'new',
              'text': 'new',
              'ts': 2,
              'historic': true,
            },
          ],
        }),
      );
      st.apply(
        ev({
          'kind': 'session',
          'id': 's',
          'root': '/p',
          'title': null,
          'model': null,
        }),
      );
      await st.loadEarlier();
      expect(asked, ['GET /history?session=s&before=2']);
      expect(st.feed.items.map((i) => (i as UserItem).id), ['old', 'new']);
      st.dispose();
    },
  );
}
