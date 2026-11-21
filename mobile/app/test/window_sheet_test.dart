import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/window_sheet.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_channel/nb_channel.dart' show HostWindow;
import 'package:nb_protocol/nb_protocol.dart' show AgentMode;
import 'package:nb_app/theme.dart';

import 'controls_test.dart' show models;
import 'support/fakes.dart';
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
  String? provider,
}) => {
  'kind': 'hello',
  'protocol': 13,
  'capabilities': Rig.caps(
    compact: compact,
    clear: clear,
    modes: modes,
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

  Finder rowOf(String text) => find.ancestor(
    of: inSheet(find.text(text)),
    matching: find.byType(InkWell),
  );

  testWidgets('one row per mode with its description; a tap asks for it', (
    t,
  ) async {
    await sheet(t);
    r.event({'kind': 'mode', 'mode': 'plan'});
    await t.pumpAndSettle();
    expect(find.byWidgetPredicate((w) => w is SegmentedButton), findsNothing);
    expect(
      find.text(modeDescription(AgentMode.default_, 'en')),
      findsOneWidget,
    );
    expect(find.text(modeDescription(AgentMode.plan, 'en')), findsOneWidget);
    final plan = rowOf(modeLabel(AgentMode.plan, 'en'));
    final dflt = rowOf(modeLabel(AgentMode.default_, 'en'));
    expect(t.getSize(plan.first).height, greaterThanOrEqualTo(48));
    // the current one carries the check
    expect(
      find.descendant(of: plan.first, matching: find.byIcon(Icons.check)),
      findsOneWidget,
    );
    await t.tap(find.text(modeLabel(AgentMode.default_, 'en')));
    await t.pumpAndSettle();
    final m = r.sent.single;
    expect((m['type'], m['mode']), ('mode', 'default'));
    // the shown mode follows the server's event, not the tap
    expect(
      find.descendant(of: plan.first, matching: find.byIcon(Icons.check)),
      findsOneWidget,
    );
    r.event({'kind': 'mode', 'mode': 'default', 'ack': m['id']});
    await t.pumpAndSettle();
    expect(
      find.descendant(of: dflt.first, matching: find.byIcon(Icons.check)),
      findsOneWidget,
    );
    expect(
      find.descendant(of: plan.first, matching: find.byIcon(Icons.check)),
      findsNothing,
    );
  });

  testWidgets('modes without prompts are in the danger colour', (t) async {
    await sheet(t, hi: hello(modes: ['default', 'auto']));
    final danger = Theme.of(
      t.element(find.byType(WindowSheet)),
    ).extension<NbColors>()!.destructive;
    Color? colorOf(AgentMode m) =>
        t.widget<Text>(inSheet(find.text(modeLabel(m, 'en')))).style?.color;
    expect(colorOf(AgentMode.auto), danger);
    expect(colorOf(AgentMode.default_), isNot(danger));
  });

  testWidgets('the modes take the web\'s texts', (t) async {
    await sheet(
      t,
      hi: hello(
        modes: ['codex-read-only', 'codex-workspace'],
        provider: 'codex',
      ),
    );
    r.event({'kind': 'mode', 'mode': 'codex-read-only'});
    await t.pumpAndSettle();
    expect(
      inSheet(find.text(modeLabel(AgentMode.codexReadOnly, 'en'))),
      findsOneWidget,
    );
    expect(
      find.text(modeDescription(AgentMode.codexReadOnly, 'en')),
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

  testWidgets('the model is in the sheet also where it cannot be switched', (
    t,
  ) async {
    await sheet(t);
    expect(inSheet(find.text('Model')), findsOneWidget);
    expect(inSheet(find.text('sonnet')), findsOneWidget);
    expect(inSheet(find.text('Model and effort')), findsNothing);
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

  testWidgets('busy: Restart is not off', (t) async {
    await sheet(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.tap(find.text('Restart'));
    await t.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
  });

  testWidgets('Clear, Compact and Stats are not here: they are the context '
      'sheet\'s', (t) async {
    await sheet(t);
    expect(find.text('Clear'), findsNothing);
    expect(find.text('Compact'), findsNothing);
    expect(find.text('Stats'), findsNothing);
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

  group('the project icon', () {
    Future<void> openWith(
      WidgetTester t,
      HostWindow w, {
      bool icons = true,
    }) async {
      await r.open(
        t,
        hello: hello(),
        events: [session()],
        win: w,
        icons: icons,
      );
      await t.tap(find.text('Spec work'));
      await t.pumpAndSettle();
    }

    testWidgets(
      'a host that knows icons offers Set icon, Remove only with one',
      (t) async {
        await openWith(t, window(4791, '/home/u/notes'));
        expect(inSheet(find.text('Set icon')), findsOneWidget);
        expect(inSheet(find.text('Remove icon')), findsNothing);
      },
    );

    testWidgets('a host without icon support offers neither', (t) async {
      await openWith(t, window(4791, '/home/u/notes'), icons: false);
      expect(inSheet(find.text('Set icon')), findsNothing);
      expect(inSheet(find.text('Remove icon')), findsNothing);
    });

    testWidgets(
      'Set icon asks where the picture comes from, as the list does',
      (t) async {
        await openWith(t, window(4791, '/home/u/notes'));
        await t.tap(inSheet(find.text('Set icon')));
        await t.pumpAndSettle();
        expect(find.text('Gallery'), findsOneWidget);
      },
    );

    testWidgets('Remove icon deletes it on the host and asks the list again', (
      t,
    ) async {
      await openWith(
        t,
        window(4791, '/home/u/notes', icon: '0123456789abcdef'),
      );
      r.ch.onHttp = (port, m, path) async => answer(204, '');
      await t.tap(inSheet(find.text('Remove icon')));
      await t.pumpAndSettle();
      final del = r.ch.calls.singleWhere((c) => c.method == 'DELETE');
      expect(del.path, '/project-icon');
      expect(r.ch.refreshes, 1);
    });

    testWidgets('Remove icon is there when the window has an icon', (t) async {
      await openWith(
        t,
        window(4791, '/home/u/notes', icon: '0123456789abcdef'),
      );
      expect(inSheet(find.text('Remove icon')), findsOneWidget);
    });

    testWidgets('the sheet closes on the tap', (t) async {
      await openWith(t, window(4791, '/home/u/notes'));
      await t.tap(inSheet(find.text('Set icon')));
      await t.pumpAndSettle();
      expect(find.byType(WindowSheet), findsNothing);
    });

    testWidgets('a window of another folder on the port is not this one', (
      t,
    ) async {
      await openWith(t, window(4791, '/home/u/other'));
      expect(inSheet(find.text('Set icon')), findsNothing);
    });

    testWidgets('without a live tab the items do nothing', (t) async {
      await openWith(t, window(4791, '/home/u/notes'));
      r.ch.close();
      await t.pumpAndSettle();
      await t.tap(inSheet(find.text('Set icon')), warnIfMissed: false);
      await t.pumpAndSettle();
      expect(find.text('Gallery'), findsNothing);
    });
  });
}
