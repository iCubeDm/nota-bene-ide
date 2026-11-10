import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/context_sheet.dart';
import 'package:nb_app/chat/window_sheet.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_app/usage/usage_screen.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/rig.dart';

Map<String, Object?> stats(Map<String, Object?> s) => {
  'kind': 'stats',
  'stats': s,
};

const ctx = {'used': 68000, 'max': 200000, 'pct': 34};

Map<String, Object?> idle({bool on = true, bool blocked = false}) => {
  'kind': 'idle-compact',
  'state': {
    'on': on,
    'blocked': blocked,
    'minutes': 5,
    'awayMinutes': 10,
    'minTokens': 20000,
  },
};

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  Finder inSheet(Finder f) =>
      find.descendant(of: find.byType(ContextSheet), matching: f);

  testWidgets('the ring opens the context sheet: the context in tokens', (
    t,
  ) async {
    await r.open(t);
    await r.openContextSheet(t, stats: stats({'context': ctx}));
    expect(find.byType(ContextSheet), findsOneWidget);
    expect(find.byType(WindowSheet), findsNothing);
    expect(inSheet(find.text('34% · 68k of 200k tokens')), findsOneWidget);
    expect(inSheet(find.byKey(const ValueKey('context-bar'))), findsOneWidget);
  });

  testWidgets('the context bar is filled to its percent, full height', (
    t,
  ) async {
    await r.open(t);
    await r.openContextSheet(t, stats: stats({'context': ctx}));
    final bar = inSheet(find.byKey(const ValueKey('context-bar')));
    final fill = find.descendant(of: bar, matching: find.byType(DecoratedBox));
    final whole = t.getSize(bar);
    final part = t.getSize(fill.last);
    expect(part.height, whole.height);
    expect(part.width, closeTo(whole.width * .34, .5));
  });

  testWidgets('rows the window does not report are left out', (t) async {
    await r.open(t);
    await r.openContextSheet(t, stats: stats({'context': ctx}));
    expect(find.text('Plan limits'), findsNothing);
    expect(find.text('This session'), findsNothing);
    expect(find.text('Compact when idle'), findsNothing);
    expect(find.text('Compact'), findsOneWidget);
    expect(find.text('Stats'), findsOneWidget);
  });

  testWidgets('limits show as two bars with their resets', (t) async {
    await r.open(t);
    await r.openContextSheet(
      t,
      stats: stats({
        'context': ctx,
        'limits': {
          'five_hour': {'utilization': 34},
          'seven_day': {'utilization': 62, 'resets_at': 'garbage'},
        },
      }),
    );
    expect(find.text('Plan limits'), findsOneWidget);
    expect(find.text('5 hours'), findsOneWidget);
    expect(find.text('Week'), findsOneWidget);
    expect(inSheet(find.text('34%')), findsOneWidget);
    expect(inSheet(find.text('62%')), findsOneWidget);
    // each bar is filled to its percent, full height
    final rows = find.byType(LimitRow);
    for (final (i, pct) in [(0, .34), (1, .62)]) {
      final row = rows.at(i);
      final track = find.descendant(of: row, matching: find.byType(Container));
      final fill = find.descendant(
        of: track.last,
        matching: find.byType(DecoratedBox),
      );
      final whole = t.getSize(track.last);
      final part = t.getSize(fill.last);
      expect(part.height, whole.height);
      expect(part.width, closeTo(whole.width * pct, .5));
    }
  });

  testWidgets('a reset another day shows the weekday and the time', (t) async {
    await r.open(t);
    await r.openContextSheet(
      t,
      stats: stats({
        'context': ctx,
        'limits': {
          'seven_day': {'utilization': 62, 'resets_at': '2030-01-02T17:30:00'},
        },
      }),
    );
    expect(inSheet(find.text('62% · resets Wed 17:30')), findsOneWidget);
  });

  testWidgets('the session cost shows when reported', (t) async {
    await r.open(t);
    await r.openContextSheet(t, stats: stats({'context': ctx, 'cost': 1.236}));
    expect(find.text('This session'), findsOneWidget);
    expect(find.text('\$1.24'), findsOneWidget);
  });

  testWidgets('the cost follows the language\'s format', (t) async {
    t.platformDispatcher.localesTestValue = const [Locale('de')];
    addTearDown(t.platformDispatcher.clearLocalesTestValue);
    await r.open(t);
    await r.openContextSheet(t, stats: stats({'context': ctx, 'cost': 1.236}));
    expect(find.textContaining('1,24'), findsOneWidget);
  });

  testWidgets('the context colours: primary, accent from 70, danger from 90', (
    t,
  ) async {
    await r.open(t);
    await r.openContextSheet(t);
    final c = Theme.of(
      t.element(find.byType(ContextSheet)),
    ).extension<NbColors>()!;
    expect(contextColor(c, 69), c.primary);
    expect(contextColor(c, 70), c.accent);
    expect(contextColor(c, 89), c.accent);
    expect(contextColor(c, 90), c.destructive);
  });

  testWidgets('idle compaction: a switch when the window reports it', (
    t,
  ) async {
    await r.open(t);
    r.event(idle(on: false));
    await r.openContextSheet(t, stats: stats({'context': ctx}));
    final sw = find.byKey(const ValueKey('idle-compact'));
    expect(sw, findsOneWidget);
    expect(
      find.text('After the turn, while the cache is warm'),
      findsOneWidget,
    );
    expect(t.widget<SwitchListTile>(sw).value, isFalse);
    await t.tap(sw);
    await t.pumpAndSettle();
    expect(r.sent.single, {'type': 'idle-compact', 'on': true});
    expect(t.widget<SwitchListTile>(sw).value, isTrue);
  });

  testWidgets('idle compaction blocked by the agent\'s settings is off', (
    t,
  ) async {
    await r.open(t);
    r.event(idle(blocked: true));
    await r.openContextSheet(t, stats: stats({'context': ctx}));
    final sw = find.byKey(const ValueKey('idle-compact'));
    expect(t.widget<SwitchListTile>(sw).onChanged, isNull);
    expect(find.text('Turned off in the agent\'s settings'), findsOneWidget);
  });

  testWidgets('no idle compaction row when the agent cannot', (t) async {
    await r.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': {...Rig.caps(), 'idleCompact': false},
      },
    );
    r.event(idle());
    await r.openContextSheet(t, stats: stats({'context': ctx}));
    expect(find.text('Compact when idle'), findsNothing);
  });

  testWidgets('Compact sends the command and closes the sheet', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
    await t.tap(find.text('Compact'));
    await t.pumpAndSettle();
    expect(r.sent.single, {'type': 'command', 'name': 'compact'});
    expect(find.byType(ContextSheet), findsNothing);
  });

  testWidgets('Compact is off while the agent works', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
    r.event({'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1});
    await t.pumpAndSettle();
    await t.tap(find.text('Compact'));
    await t.pumpAndSettle();
    expect(r.sent, isEmpty);
    expect(
      runWindowCommand(r.tab!, ClientMessageCommandName.compact, 'en'),
      webString('working', 'en'),
    );
  });

  testWidgets('Compact is off offline', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
    r.ch.drop();
    await t.pumpAndSettle();
    await t.tap(find.text('Compact'));
    await t.pumpAndSettle();
    expect(r.sent, isEmpty);
  });

  testWidgets('no Compact when the agent cannot', (t) async {
    await r.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': Rig.caps(compact: false),
      },
    );
    await r.openContextSheet(t);
    expect(find.text('Compact'), findsNothing);
    expect(find.text('Stats'), findsOneWidget);
  });

  Future<void> confirmClear(WidgetTester t) async {
    await t.tap(find.text('Clear'));
    await t.pumpAndSettle();
  }

  testWidgets('Clear asks first and sends only on its button', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
    await t.tap(find.text('Clear'));
    await t.pumpAndSettle();
    expect(find.text(webString('clearTitle', 'en')), findsOneWidget);
    expect(r.sent, isEmpty);
    await t.tap(find.widgetWithText(TextButton, 'Cancel'));
    await t.pumpAndSettle();
    expect(r.sent, isEmpty);
    await t.tap(find.text('Clear'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(FilledButton, webString('clearBtn', 'en')));
    await t.pumpAndSettle();
    expect(r.sent.single, {'type': 'command', 'name': 'clear'});
    expect(find.byType(ContextSheet), findsNothing);
  });

  testWidgets('Clear sits between Compact and Stats', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
    double x(String s) => t.getCenter(find.text(s)).dx;
    expect(x('Compact'), lessThan(x('Clear')));
    expect(x('Clear'), lessThan(x('Stats')));
  });

  testWidgets('Clear refused while the agent works: the web\'s note', (
    t,
  ) async {
    await r.open(t);
    await r.openContextSheet(t);
    await confirmClear(t);
    r.event({'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1});
    await t.pump();
    await t.tap(find.widgetWithText(FilledButton, webString('clearBtn', 'en')));
    await t.pumpAndSettle();
    expect(r.sent, isEmpty);
    expect(
      find.text(webString('clearFail', 'en') + webString('working', 'en')),
      findsOneWidget,
    );
  });

  testWidgets('Clear refused offline: the web\'s note', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
    await confirmClear(t);
    r.ch.drop();
    await t.pump();
    await t.tap(find.widgetWithText(FilledButton, webString('clearBtn', 'en')));
    await t.pumpAndSettle();
    expect(
      find.text(webString('clearFail', 'en') + webString('offline', 'en')),
      findsOneWidget,
    );
  });

  testWidgets('Clear is off while the agent works', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
    r.event({'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1});
    await t.pumpAndSettle();
    await t.tap(find.text('Clear'));
    await t.pumpAndSettle();
    expect(find.text(webString('clearTitle', 'en')), findsNothing);
    expect(r.sent, isEmpty);
  });

  testWidgets('no Clear when the agent cannot', (t) async {
    await r.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': Rig.caps(clear: false),
      },
    );
    await r.openContextSheet(t);
    expect(find.text('Clear'), findsNothing);
    expect(find.text('Compact'), findsOneWidget);
    expect(find.text('Stats'), findsOneWidget);
  });

  testWidgets('Stats opens the usage screen', (t) async {
    await r.open(t);
    await r.openContextSheet(t);
    await t.tap(find.text('Stats'));
    await t.pump();
    await t.pump(const Duration(seconds: 1));
    expect(find.byType(UsageScreen), findsOneWidget);
  });
}
