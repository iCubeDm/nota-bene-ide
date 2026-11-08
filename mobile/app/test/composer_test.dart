import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rig.dart';

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  testWidgets('send writes a send message and clears the field', (t) async {
    await r.open(t);
    await t.enter('Next step please');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    final m = r.sent.single;
    expect((m['type'], m['text']), ('send', 'Next step please'));
    expect(m['id'], matches(RegExp(r'^[0-9a-f-]{36}$')));
    expect(m.containsKey('force'), isFalse);
    expect(find.text('Next step please'), findsNothing);
  });

  testWidgets('send while busy asks and sends force', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.enter('Change of plan');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    expect(textIn('interrupt'), findsWidgets);
    await t.tapText('Send now');
    expect(r.sent.single['force'], isTrue);
  });

  testWidgets('while busy a message can wait for its turn instead', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.enter('After that, this');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    await t.tapText('Send after this turn');
    final m = r.sent.single;
    expect((m['text'], m.containsKey('force')), ('After that, this', false));
  });

  testWidgets('a send that cannot go keeps the text', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.enter('Keep me');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    r.event({
      'kind': 'occupied',
    }); // another tab took the window while the dialog was up
    await t.pumpAndSettle();
    await t.tapText('Send now');
    expect(r.sent, isEmpty);
    expect(find.text('Keep me'), findsOneWidget);
  });

  testWidgets('send-refused keeps the text', (t) async {
    await r.open(t);
    await t.enter('Hello');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    r.event({
      'kind': 'send-refused',
      'id': r.sent.single['id'],
      'reason': 'switching',
    });
    await t.pumpAndSettle();
    expect(find.text('Hello'), findsOneWidget);
    expect(find.byType(SnackBar), findsOneWidget);
  });

  testWidgets('stop is offered while busy and sends interrupt', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.tap(find.byTooltip('Stop'));
    await t.pumpAndSettle();
    expect(r.sent.single, {'type': 'interrupt'});
  });

  testWidgets('offline disables sending and shows the last-seen time', (
    t,
  ) async {
    await r.open(t);
    r.ch.drop();
    await t.pumpAndSettle();
    expect(textIn('Offline'), findsWidgets);
    final field = t.widget<TextField>(find.byType(TextField));
    expect(field.enabled, isFalse);
    expect(
      t
          .widget<IconButton>(find.widgetWithIcon(IconButton, Icons.send))
          .onPressed,
      isNull,
    );
  });
}
