import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rig.dart';

Map<String, Object?> plain(String id, String command) => {
  'kind': 'permission',
  'id': id,
  'toolName': 'Bash',
  'input': {'command': command},
  'ts': 1,
};

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  testWidgets('a permission opens the sheet with the full command', (t) async {
    await r.open(t);
    r.event(plain('p1', 'rm -rf build && npm run build -- --very-long-flag'));
    await t.pumpAndSettle();
    expect(find.byType(BottomSheet), findsOneWidget);
    expect(
      find.text('rm -rf build && npm run build -- --very-long-flag'),
      findsOneWidget,
    );
  });

  testWidgets('Allow sends allow true and closes the sheet', (t) async {
    await r.open(t);
    r.event(plain('p1', 'ls'));
    await t.pumpAndSettle();
    await t.tapText('Allow');
    expect(r.sent.single, {'type': 'permission', 'id': 'p1', 'allow': true});
    expect(find.byType(BottomSheet), findsNothing);
  });

  testWidgets('permission-done closes the sheet', (t) async {
    await r.open(t);
    r.event(plain('p1', 'ls'));
    await t.pumpAndSettle();
    r.event({'kind': 'permission-done', 'id': 'p1', 'allow': true, 'ts': 2});
    await t.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    expect(
      r.sent,
      isEmpty,
      reason: 'answered elsewhere: nothing goes from here',
    );
  });

  testWidgets('an answered or replayed ask opens no sheet', (t) async {
    await r.open(
      t,
      events: [
        plain('p0', 'old'),
        {'kind': 'permission-done', 'id': 'p0', 'allow': false, 'ts': 2},
      ],
    );
    expect(find.byType(BottomSheet), findsNothing);
  });

  testWidgets(
    'a structured prompt needs its required field except for decline',
    (t) async {
      await r.open(t);
      r.event({
        'kind': 'permission',
        'id': 'q1',
        'toolName': 'request_user_input',
        'input': {},
        'prompt': {
          'title': 'Which branch?',
          'choices': [
            {'id': 'accept', 'label': 'Send answers'},
            {'id': 'decline', 'label': 'Decline'},
          ],
          'fields': [
            {'id': 'branch', 'label': 'Branch name', 'required': true},
          ],
        },
        'ts': 1,
      });
      await t.pumpAndSettle();
      expect(
        find.byType(BottomSheet),
        findsNothing,
        reason: 'questions are answered in the feed',
      );
      expect(find.text('Which branch?'), findsOneWidget);
      final send = find.widgetWithText(FilledButton, 'Send answers');
      expect(t.widget<FilledButton>(send).onPressed, isNull);
      expect(
        t
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Deny'))
            .onPressed,
        isNotNull,
      );
      await t.enterText(find.byType(TextField).first, 'main');
      await t.pump();
      await t.tap(send);
      await t.pumpAndSettle();
      expect(r.sent.single, {
        'type': 'permission',
        'id': 'q1',
        'allow': true,
        'response': {
          'choice': 'accept',
          'values': {'branch': 'main'},
        },
      });
    },
  );

  testWidgets(
    'AskUserQuestion options show descriptions; single replaces, several are comma-separated',
    (t) async {
      await r.open(t);
      r.event({
        'kind': 'permission',
        'id': 'ask',
        'toolName': 'Claude',
        'input': {},
        'prompt': {
          'title': 'Claude',
          'choices': [
            {'id': 'submit', 'label': 'Send answers'},
            {'id': 'cancel', 'label': 'Cancel'},
          ],
          'fields': [
            {
              'id': 'q0',
              'label': 'Which library?',
              'header': 'Library',
              'required': true,
              'options': ['dayjs', 'luxon'],
              'notes': ['small', 'zones'],
            },
            {
              'id': 'q1',
              'label': 'Which features?',
              'required': true,
              'multi': true,
              'options': ['A', 'B', 'C'],
              'notes': ['a', 'b', 'c'],
            },
          ],
        },
        'ts': 1,
      });
      await t.pumpAndSettle();
      expect(find.text('Library'), findsOneWidget);
      expect(find.text('zones'), findsOneWidget);
      await t.tap(find.text('dayjs'));
      await t.tap(find.text('luxon'));
      await t.tap(find.text('A'));
      await t.tap(find.text('C'));
      await t.pump();
      await t.tap(find.widgetWithText(FilledButton, 'Send answers'));
      await t.pumpAndSettle();
      expect(r.sent.single['response'], {
        'choice': 'submit',
        'values': {'q0': 'luxon', 'q1': 'A, C'},
      });
    },
  );

  testWidgets(
    'the sheet closes without sending when the tab loses the window',
    (t) async {
      await r.open(t);
      r.event(plain('p1', 'ls'));
      await t.pumpAndSettle();
      r.event({'kind': 'occupied'});
      await t.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(r.sent, isEmpty);
    },
  );
}
