import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_header.dart';
import 'package:nb_app/chat/chat_screen.dart';
import 'package:nb_app/chat/window_tab.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_app/main.dart';

import 'support/rig.dart';

Map<String, Object?> session({String? title}) => {
  'kind': 'session',
  'id': 's',
  'root': '/home/u/notes',
  'title': ?title,
  'model': 'opus',
};

Map<String, Object?> stats(Map<String, Object?> limits) => {
  'kind': 'stats',
  'stats': {'limits': limits},
};

Map<String, Object?> context(num pct, {num used = 1000, num max = 200000}) => {
  'kind': 'stats',
  'stats': {
    'context': {'used': used, 'max': max, 'pct': pct},
  },
};

void main() {
  test('the provider letter', () {
    expect(providerLetter('claude'), 'C');
    expect(providerLetter('codex'), 'X');
    expect(providerLetter('omp'), 'O');
    expect(providerLetter('gemini'), 'G');
    expect(providerLetter(null), '?');
    expect(providerLetter(''), '?');
  });

  late Rig rig;
  setUp(() => rig = Rig());
  tearDown(() {
    if (rig.tab != null) rig.dispose();
  });

  testWidgets('the pill shows the title, not the model', (t) async {
    await rig.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': Rig.caps(provider: 'codex'),
      },
      events: [session(title: 'Spec work')],
    );
    expect(find.text('Spec work'), findsOneWidget);
    expect(find.text('opus'), findsNothing);
    expect(find.text('X'), findsOneWidget);
  });

  Future<void> modeHeader(
    WidgetTester t,
    List<String> modes,
    String mode,
  ) async {
    await rig.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': Rig.caps(modes: modes),
      },
      events: [session(title: 'x')],
    );
    rig.event({'kind': 'mode', 'mode': mode});
    await t.pumpAndSettle();
  }

  testWidgets('no modes, no mode in the header', (t) async {
    await modeHeader(t, [], 'default');
    expect(find.text(webString('mode_default', 'en')), findsNothing);
  });

  testWidgets('one mode, no mode in the header', (t) async {
    await modeHeader(t, ['default'], 'default');
    expect(find.text(webString('mode_default', 'en')), findsNothing);
  });

  testWidgets('two modes, the current one in the header', (t) async {
    await modeHeader(t, ['default', 'plan'], 'plan');
    expect(find.text(webString('mode_plan', 'en')), findsOneWidget);
  });

  testWidgets('a mode the agent does not offer is not shown', (t) async {
    await modeHeader(t, ['default', 'plan'], 'acceptEdits');
    expect(find.text(webString('mode_acceptEdits', 'en')), findsNothing);
  });

  testWidgets('no title reads untitled', (t) async {
    await rig.open(t, events: [session()]);
    expect(find.text('untitled'), findsOneWidget);
  });

  testWidgets(
    'the context is a ring with its percent; the limits are not in the header',
    (t) async {
      final h = t.ensureSemantics();
      await rig.open(t, events: [session(title: 'x')]);
      // no context reported: no ring
      expect(find.byKey(const ValueKey('context-ring')), findsNothing);
      rig.event({
        'kind': 'stats',
        'stats': {
          'context': {'used': 1, 'max': 2, 'pct': 42.4},
          'limits': {
            'five_hour': {'utilization': 42},
            'seven_day': {'utilization': 7.4},
          },
        },
      });
      await t.pumpAndSettle();
      expect(find.byKey(const ValueKey('context-ring')), findsOneWidget);
      expect(
        t.getSize(find.byKey(const ValueKey('context-ring'))),
        const Size(40, 40),
      );
      expect(find.text('42'), findsOneWidget);
      expect(find.bySemanticsLabel('Context 42%'), findsOneWidget);
      expect(find.text('5 hours'), findsNothing);
      rig.event(context(130));
      await t.pumpAndSettle();
      expect(find.bySemanticsLabel('Context 100%'), findsOneWidget);
      h.dispose();
    },
  );

  testWidgets('the mode is not in the pill: it is under Chat', (t) async {
    await modeHeader(t, ['default', 'plan'], 'plan');
    expect(
      find.descendant(
        of: find.byType(ChatHeader),
        matching: find.text(webString('mode_plan', 'en')),
      ),
      findsNothing,
    );
    expect(find.text(webString('mode_plan', 'en')), findsOneWidget);
  });

  testWidgets('a long title and model ellipsize, the buttons keep size', (
    t,
  ) async {
    await rig.open(t, events: [session(title: 'T' * 300)]);
    rig.event({'kind': 'model', 'model': 'm' * 300});
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    final back = find.byTooltip('Back');
    expect(t.getSize(back), const Size(40, 40));
  });

  testWidgets('tapping the pill calls onTapTitle; without it, no InkWell', (
    t,
  ) async {
    await rig.open(t, events: [session(title: 'Spec work')]);
    var taps = 0;
    final own = WindowTab(rig.link, 4791, '/home/u/notes', retry: (_) async {});
    addTearDown(own.dispose);
    await t.pumpWidget(
      NbApp(
        home: Scaffold(
          body: ChatHeader(tab: own, onTapTitle: () => taps++),
        ),
      ),
    );
    expect(
      find.ancestor(of: find.text('untitled'), matching: find.byType(InkWell)),
      findsOneWidget,
    );
    await t.tap(find.text('untitled'));
    expect(taps, 1);
    await t.pumpWidget(
      NbApp(
        home: Scaffold(body: ChatHeader(tab: own)),
      ),
    );
    expect(
      find.ancestor(of: find.text('untitled'), matching: find.byType(InkWell)),
      findsNothing,
    );
  });

  testWidgets('the back button pops the route', (t) async {
    await rig.open(t, events: [session(title: 'x')]);
    final own = WindowTab(rig.link, 4791, '/home/u/notes', retry: (_) async {});
    addTearDown(own.dispose);
    await t.pumpWidget(
      NbApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => ChatScreen(tab: own)),
            ),
            child: const Text('go'),
          ),
        ),
      ),
    );
    await t.tap(find.text('go'));
    await t.pumpAndSettle();
    expect(find.byType(ChatHeader), findsOneWidget);
    await t.tap(find.byTooltip('Back'));
    await t.pumpAndSettle();
    expect(find.byType(ChatHeader), findsNothing);
    expect(find.text('go'), findsOneWidget);
  });

  NbColors colors(WidgetTester t) =>
      Theme.of(t.element(find.byType(ChatHeader))).extension<NbColors>()!;
  Color ringColor(WidgetTester t) =>
      (t
                      .widget<CustomPaint>(
                        find.byKey(const ValueKey('context-ring')),
                      )
                      .painter!
                  as dynamic)
              .color
          as Color;

  testWidgets('the ring is primary below 70, accent from 70, danger from 90', (
    t,
  ) async {
    await rig.open(t, events: [session(title: 'x')]);
    final c = colors(t);
    Future<void> set(num pct) async {
      rig.event(context(pct));
      await t.pumpAndSettle();
    }

    await set(0);
    expect(ringColor(t), c.primary);
    await set(69);
    expect(ringColor(t), c.primary);
    await set(70);
    expect(ringColor(t), c.accent);
    await set(89);
    expect(ringColor(t), c.accent);
    await set(90);
    expect(ringColor(t), c.destructive);
  });

  testWidgets('without a live link the ring dims and keeps its value', (
    t,
  ) async {
    await rig.open(t, events: [session(title: 'x')]);
    rig.event(context(72));
    await t.pumpAndSettle();
    double opacity() => t
        .widget<Opacity>(
          find.ancestor(
            of: find.byKey(const ValueKey('context-ring')),
            matching: find.byType(Opacity),
          ),
        )
        .opacity;
    expect(opacity(), 1);
    rig.ch.drop();
    await t.pumpAndSettle();
    expect(opacity(), lessThan(1));
    expect(find.text('72'), findsOneWidget);
  });

  testWidgets('the ring says its name in the app language', (t) async {
    t.platformDispatcher.localesTestValue = const [Locale('ru')];
    addTearDown(t.platformDispatcher.clearLocalesTestValue);
    final h = t.ensureSemantics();
    await rig.open(t, events: [session(title: 'x')]);
    rig.event(context(42));
    await t.pumpAndSettle();
    expect(find.bySemanticsLabel('Контекст 42%'), findsOneWidget);
    h.dispose();
  });

  testWidgets('a large text scale does not overflow the pill', (t) async {
    t.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
    await rig.open(t, events: [session(title: 'Spec work')]);
    rig.event(context(42));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
  });

  testWidgets('the ring and a long mode fit 320 dp', (t) async {
    t.view.physicalSize = const Size(320, 640);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await modeHeader(t, ['default', 'plan'], 'plan');
    rig.event(context(100));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('100'), findsOneWidget);
  });
}
