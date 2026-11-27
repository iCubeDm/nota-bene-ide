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

  testWidgets('compact sends the command', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
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

  testWidgets(
    'issue 673: a long list scrolls; effort and Apply stay on a phone screen',
    (t) async {
      t.view.physicalSize = const Size(390, 844);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await r.open(t);
      r.event({
        'kind': 'models',
        'models': [
          for (var i = 0; i < 12; i++)
            {
              'value': 'm$i',
              'name': 'Model $i',
              'description':
                  'A model with a description long enough to take two lines in the sheet',
              'efforts': ['low', 'high'],
            },
        ],
      });
      r.event({'kind': 'model', 'model': 'm11'});
      await t.pumpAndSettle();
      await menu(t);
      await t.tapText('Model and effort');
      await t.tapText('high');
      await t.tapText('Apply');
      final m = r.sent.single;
      expect((m['type'], m['model'], m['effort']), ('model', 'm11', 'high'));
    },
  );

  testWidgets('no model entry without the capability', (t) async {
    await r.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 41,
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
}
