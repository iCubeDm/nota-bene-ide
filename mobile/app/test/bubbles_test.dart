import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_screen.dart';
import 'package:nb_app/theme.dart';

import 'support/rig.dart';

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  Future<void> open(WidgetTester t, List<Map<String, Object?>> events) async {
    t.view.physicalSize = const Size(400, 800);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await r.open(t, events: events);
  }

  Map<String, Object?> user(String id, String text) => {
    'kind': 'user',
    'id': id,
    'text': text,
    'ts': 1,
    'historic': true,
  };

  Rect rectOf(WidgetTester t, Finder f) => t.getRect(f);

  testWidgets(
    'a reply fills the width from 8 px at the left to 28 at the right',
    (t) async {
      await open(t, [
        user('u1', 'Hi'),
        agent({'t': 'message', 'id': 'a1', 'text': 'Short'}),
      ]);
      final b = rectOf(t, find.byKey(const ValueKey('agent-bubble')));
      expect(b.left, 8);
      expect(b.right, 400 - 28);
      final c = Theme.of(
        t.element(find.byType(ChatScreen)),
      ).extension<NbColors>()!;
      final box = t.widget<Container>(
        find.byKey(const ValueKey('agent-bubble')),
      );
      expect((box.decoration as BoxDecoration).color, c.agentBubble);
      expect(c.agentBubble, isNot(c.userBubble));
    },
  );

  testWidgets('a short user message shrinks to the right, 8 px from the edge', (
    t,
  ) async {
    await open(t, [user('u1', 'Hi')]);
    final b = rectOf(t, find.byKey(const ValueKey('bubble')));
    expect(b.right, 400 - 8);
    expect(b.width, lessThan(100));
  });

  testWidgets('a long user message stops 28 px from the left edge', (t) async {
    await open(t, [user('u1', 'word ' * 120)]);
    final b = rectOf(t, find.byKey(const ValueKey('bubble')));
    expect(b.left, 28);
    expect(b.right, 400 - 8);
  });

  testWidgets(
    'texts and tools of one turn are one bubble: no gap, the top and bottom rounded once',
    (t) async {
      await open(t, [
        user('u1', 'Go'),
        agent({'t': 'message', 'id': 'a1', 'text': 'First'}),
        agent({
          't': 'tool-call',
          'id': 't1',
          'name': 'Bash',
          'input': {'command': 'ls'},
          'sub': false,
        }),
        agent({'t': 'message', 'id': 'a2', 'text': 'Second'}),
        agent({
          't': 'turn-end',
          'stop': 'interrupted',
          'secs': 3,
          'queued': 0,
          'answers': 'all',
        }),
        user('u2', 'More'),
        agent({'t': 'message', 'id': 'a3', 'text': 'Third'}),
      ]);
      final bubbles = find.byKey(const ValueKey('agent-bubble'));
      expect(bubbles, findsNWidgets(4));
      final rs = [for (var i = 0; i < 4; i++) t.getRect(bubbles.at(i))]
        ..sort((a, b) => a.top.compareTo(b.top));
      // the three pieces of the first turn touch
      expect(rs[0].bottom, rs[1].top);
      expect(rs[1].bottom, rs[2].top);
      // the turn's end line is outside, centred; the next turn is apart
      final done = rectOf(t, find.textContaining('Stopped after'));
      expect(done.top, greaterThanOrEqualTo(rs[2].bottom));
      expect((done.center.dx - 200).abs(), lessThan(1));
      expect(rs[3].top, greaterThan(rs[2].bottom + 10));
    },
  );
}
