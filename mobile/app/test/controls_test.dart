import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rig.dart';

final models = {
  'kind': 'models',
  'models': [
    {
      'value': 'opus',
      'name': 'Opus',
      'description': 'Most capable',
      'efforts': ['low', 'high', 'max'],
      'defaultEffort': 'high',
    },
    {'value': 'sonnet', 'name': 'Sonnet', 'description': 'Fast'},
  ],
};

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  Future<void> menu(WidgetTester t) async {
    await t.tap(find.text('untitled'));
    await t.pumpAndSettle();
  }

  testWidgets('the window sheet: compact is disabled while busy', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await menu(t);
    await t.tap(find.text('Compact'));
    await t.pumpAndSettle();
    expect(r.sent, isEmpty);
  });

  testWidgets('compact sends the command', (t) async {
    await r.open(t);
    await menu(t);
    await t.tapText('Compact');
    expect(r.sent.single, {'type': 'command', 'name': 'compact'});
  });

  testWidgets('the model sheet sends model and effort', (t) async {
    await r.open(t);
    r.event(models);
    r.event({'kind': 'model', 'model': 'sonnet'});
    await t.pumpAndSettle();
    await menu(t);
    await t.tapText('Model and effort');
    await t.tapText('Opus');
    await t.tapText('max');
    await t.tapText('Apply');
    final m = r.sent.single;
    expect((m['type'], m['model'], m['effort']), ('model', 'opus', 'max'));
  });

  testWidgets('no model entry without the capability', (t) async {
    await r.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': Rig.caps(models: false),
      },
    );
    r.event(models);
    await t.pumpAndSettle();
    await menu(t);
    expect(find.text('Model and effort'), findsNothing);
  });

  testWidgets('restart asks first', (t) async {
    await r.open(t);
    await menu(t);
    await t.tapText('Restart');
    expect(r.sent, isEmpty);
    await t.tap(find.widgetWithText(FilledButton, 'Restart'));
    await t.pumpAndSettle();
    expect(r.sent.single, {'type': 'restart'});
  });

  testWidgets('the agent menu keeps Files only', (t) async {
    await r.open(t);
    await t.tap(find.byTooltip('Agent'));
    await t.pumpAndSettle();
    expect(
      find.widgetWithText(PopupMenuItem<Object?>, 'Files'),
      findsOneWidget,
    );
    expect(find.text('Compact'), findsNothing);
    expect(find.text('Restart agent'), findsNothing);
  });

  testWidgets('Work here calls takeover', (t) async {
    await r.open(t);
    r.event({'kind': 'occupied'});
    await t.pumpAndSettle();
    expect(textIn('another tab'), findsOneWidget);
    await t.tapText('Work here');
    expect(r.sent.last, {'type': 'takeover'});
  });
}
