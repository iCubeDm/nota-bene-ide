import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/window_sheet.dart';
import 'package:nb_protocol/nb_protocol.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_app/usage/usage_screen.dart';

import 'controls_test.dart' show models;
import 'support/rig.dart';

Map<String, Object?> session() => {
  'kind': 'session',
  'id': 's',
  'root': '/home/u/notes',
  'title': 'Spec work',
  'model': 'sonnet',
};

Map<String, Object?> hello({
  bool compact = true,
  bool clear = true,
  List<String> modes = const ['default', 'plan'],
  List<Map<String, Object?>>? descriptors,
  String? provider,
}) => {
  'kind': 'hello',
  'protocol': 13,
  'capabilities': Rig.caps(
    compact: compact,
    clear: clear,
    modes: modes,
    modeDescriptors: descriptors,
    provider: provider,
  ),
};

Finder inSheet(Finder f) =>
    find.descendant(of: find.byType(WindowSheet), matching: f);

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  Future<void> sheet(
    WidgetTester t, {
    Map<String, Object?>? hi,
    List<Map<String, Object?>> events = const [],
  }) async {
    await r.open(t, hello: hi ?? hello(), events: [session(), ...events]);
    await t.tap(find.text('Spec work'));
    await t.pumpAndSettle();
  }

  testWidgets('the header title opens the sheet with title and folder', (
    t,
  ) async {
    await sheet(t);
    expect(find.text('Spec work'), findsNWidgets(2));
    expect(find.text('/home/u/notes'), findsOneWidget);
  });

  testWidgets('one segment per mode, the current selected, its description', (
    t,
  ) async {
    await sheet(t);
    r.event({'kind': 'mode', 'mode': 'plan'});
    await t.pumpAndSettle();
    final seg = t.widget<SegmentedButton<dynamic>>(
      find.byWidgetPredicate((w) => w is SegmentedButton),
    );
    expect(seg.segments, hasLength(2));
    expect(seg.selected.single.toString(), contains('plan'));
    expect(find.text(webString('mode_plan_desc', 'en')), findsOneWidget);
    await t.tap(find.text(webString('mode_default', 'en')));
    await t.pumpAndSettle();
    final m = r.sent.single;
    expect((m['type'], m['mode']), ('mode', 'default'));
    // the shown mode follows the server's event, not the tap
    expect(find.text(webString('mode_plan_desc', 'en')), findsOneWidget);
    r.event({'kind': 'mode', 'mode': 'default', 'ack': m['id']});
    await t.pumpAndSettle();
    expect(find.text(webString('mode_default_desc', 'en')), findsOneWidget);
  });

  testWidgets('the host\'s mode descriptors name the modes (not Codex)', (
    t,
  ) async {
    await sheet(
      t,
      hi: hello(
        modes: ['default', 'plan'],
        descriptors: [
          {'id': 'default', 'name': 'Ask first', 'description': 'Asks a lot'},
          {'id': 'plan', 'name': 'Think', 'description': 'Plans'},
        ],
      ),
    );
    r.event({'kind': 'mode', 'mode': 'default'});
    await t.pumpAndSettle();
    expect(inSheet(find.text('Ask first')), findsOneWidget);
    expect(find.text('Asks a lot'), findsOneWidget);
  });

  testWidgets('Codex takes the web\'s texts', (t) async {
    await sheet(
      t,
      hi: hello(
        modes: ['codex-read-only', 'codex-workspace'],
        provider: 'codex',
        descriptors: [
          {
            'id': 'codex-read-only',
            'name': 'Host name',
            'description': 'Host description',
          },
        ],
      ),
    );
    r.event({'kind': 'mode', 'mode': 'codex-read-only'});
    await t.pumpAndSettle();
    expect(find.text('Host name'), findsNothing);
    expect(find.text('Host description'), findsNothing);
    expect(
      inSheet(find.text(webString('mode_codex-read-only', 'en'))),
      findsOneWidget,
    );
    expect(
      find.text(webString('mode_codex-read-only_desc', 'en')),
      findsOneWidget,
    );
  });

  testWidgets('no modes, no mode row and no heading', (t) async {
    await sheet(t, hi: hello(modes: []));
    expect(find.byWidgetPredicate((w) => w is SegmentedButton), findsNothing);
    expect(find.text('Mode'), findsNothing);
  });

  testWidgets('one mode, no mode row and no heading', (t) async {
    await sheet(t, hi: hello(modes: ['default']));
    expect(find.byWidgetPredicate((w) => w is SegmentedButton), findsNothing);
    expect(find.text('Mode'), findsNothing);
  });

  testWidgets('limits show as two bars, none without stats', (t) async {
    await sheet(t);
    expect(find.text('Plan limits'), findsNothing);
    r.event({
      'kind': 'stats',
      'stats': {
        'limits': {
          'five_hour': {'utilization': 34},
          'seven_day': {'utilization': 62, 'resets_at': 'garbage'},
        },
      },
    });
    await t.pumpAndSettle();
    expect(find.text('Plan limits'), findsOneWidget);
    expect(find.text('5 hours'), findsOneWidget);
    expect(find.text('Week'), findsOneWidget);
    expect(inSheet(find.text('34%')), findsOneWidget);
    expect(inSheet(find.text('62%')), findsOneWidget);
  });

  testWidgets('a reset another day shows the weekday and the time', (t) async {
    await sheet(t);
    r.event({
      'kind': 'stats',
      'stats': {
        'limits': {
          'seven_day': {'utilization': 62, 'resets_at': '2030-01-02T17:30:00'},
        },
      },
    });
    await t.pumpAndSettle();
    expect(inSheet(find.text('62% · resets Wed 17:30')), findsOneWidget);
  });

  testWidgets('Compact sends the command and closes the sheet', (t) async {
    await sheet(t);
    await t.tap(find.text('Compact'));
    await t.pumpAndSettle();
    expect(r.sent.single, {'type': 'command', 'name': 'compact'});
    expect(find.byType(WindowSheet), findsNothing);
  });

  testWidgets('Clear asks first and sends only on its button', (t) async {
    await sheet(t);
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
    expect(find.byType(WindowSheet), findsNothing);
  });

  Future<void> confirmClear(WidgetTester t) async {
    await t.tap(find.text('Clear'));
    await t.pumpAndSettle();
  }

  testWidgets('Clear refused while the agent works: the web\'s note', (
    t,
  ) async {
    await sheet(t);
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
    await sheet(t);
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

  testWidgets('Compact refused offline says why', (t) async {
    await sheet(t);
    r.ch.drop();
    await t.tap(find.text('Compact'));
    await t.pumpAndSettle();
    expect(find.text(webString('offline', 'en')), findsOneWidget);
  });

  testWidgets('Compact refused while the agent works says why', (t) async {
    await sheet(t);
    r.event({'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1});
    await t.pump();
    final tab = r.tab!;
    expect(
      runWindowCommand(tab, ClientMessageCommandName.compact, 'en'),
      webString('working', 'en'),
    );
    expect(r.sent, isEmpty);
  });

  testWidgets('Restart asks, then sends', (t) async {
    await sheet(t);
    await t.tap(find.text('Restart'));
    await t.pumpAndSettle();
    expect(r.sent, isEmpty);
    await t.tap(find.widgetWithText(FilledButton, 'Restart'));
    await t.pumpAndSettle();
    expect(r.sent.single, {'type': 'restart'});
  });

  testWidgets('Stats opens the usage screen', (t) async {
    await sheet(t);
    await t.tap(find.text('Stats'));
    await t.pump();
    await t.pump(const Duration(seconds: 1));
    expect(find.byType(UsageScreen), findsOneWidget);
  });

  testWidgets('busy: Compact and Clear are off, Restart is not', (t) async {
    await sheet(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.tap(find.text('Compact'));
    await t.tap(find.text('Clear'));
    await t.pumpAndSettle();
    expect(find.text(webString('clearTitle', 'en')), findsNothing);
    expect(r.sent, isEmpty);
    await t.tap(find.text('Restart'));
    await t.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
  });

  testWidgets('no Compact or Clear when the agent cannot', (t) async {
    await sheet(t, hi: hello(compact: false, clear: false));
    expect(find.text('Compact'), findsNothing);
    expect(find.text('Clear'), findsNothing);
    expect(find.text('Restart'), findsOneWidget);
  });

  testWidgets('the model row shows the model and opens the model sheet', (
    t,
  ) async {
    await r.open(t, hello: hello(), events: [session()]);
    r.event(models);
    r.event({'kind': 'model', 'model': 'opus', 'effort': 'high'});
    await t.pumpAndSettle();
    await t.tap(find.text('Spec work'));
    await t.pumpAndSettle();
    expect(find.textContaining('Opus'), findsOneWidget);
    await t.tap(find.text('Model and effort'));
    await t.pumpAndSettle();
    expect(find.text('Apply'), findsOneWidget);
  });

  testWidgets('no model row without models', (t) async {
    await sheet(t);
    expect(find.text('Model and effort'), findsNothing);
  });
}
