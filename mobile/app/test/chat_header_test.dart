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

  testWidgets('the context makes one meter; the limits are not in the header', (
    t,
  ) async {
    final h = t.ensureSemantics();
    await rig.open(t, events: [session(title: 'x')]);
    expect(find.bySemanticsLabel(RegExp(r'^context ')), findsNothing);
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
    expect(find.bySemanticsLabel('context 42%'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^(5h|week) ')), findsNothing);
    rig.event(context(130));
    await t.pumpAndSettle();
    expect(find.bySemanticsLabel('context 100%'), findsOneWidget);
    h.dispose();
  });

  testWidgets('no context yet: just the mode', (t) async {
    await modeHeader(t, ['default', 'plan'], 'plan');
    expect(find.text(webString('mode_plan', 'en')), findsOneWidget);
    expect(find.byKey(const ValueKey('fill-ctx')), findsNothing);
    rig.event(context(10));
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('fill-ctx')), findsOneWidget);
    expect(find.text('10%'), findsOneWidget);
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

  Color fill(WidgetTester t, String key) =>
      (t.widget<DecoratedBox>(find.byKey(ValueKey('fill-$key'))).decoration
              as BoxDecoration)
          .color!;
  NbColors colors(WidgetTester t) =>
      Theme.of(t.element(find.byType(ChatHeader))).extension<NbColors>()!;
  Color? pctColor(WidgetTester t, String s) =>
      t.widget<Text>(find.text(s)).style!.color;

  testWidgets(
    'the context meter takes the web\'s levels: 60 warns, 85 is hot',
    (t) async {
      await rig.open(t, events: [session(title: 'x')]);
      final c = colors(t);
      Future<void> set(num pct) async {
        rig.event(context(pct));
        await t.pumpAndSettle();
      }

      await set(59);
      expect(fill(t, 'ctx'), c.primary);
      expect(pctColor(t, '59%'), c.mutedFg);
      await set(60);
      expect(fill(t, 'ctx'), c.accent);
      await set(84);
      expect(fill(t, 'ctx'), c.accent);
      await set(85);
      expect(fill(t, 'ctx'), c.destructive);
      expect(pctColor(t, '85%'), c.destructive);
      await set(0);
      expect(fill(t, 'ctx'), c.primary);
    },
  );

  testWidgets('the context label is the web\'s word in the app language', (
    t,
  ) async {
    t.platformDispatcher.localesTestValue = const [Locale('ru')];
    addTearDown(t.platformDispatcher.clearLocalesTestValue);
    final h = t.ensureSemantics();
    await rig.open(t, events: [session(title: 'x')]);
    rig.event(context(42));
    await t.pumpAndSettle();
    final word = webString('ctx', 'ru');
    expect(word, isNot('context'));
    expect(find.text(word), findsOneWidget);
    expect(find.bySemanticsLabel('$word 42%'), findsOneWidget);
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

  testWidgets('the context meter and a long mode fit 320 dp', (t) async {
    t.view.physicalSize = const Size(320, 640);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await modeHeader(t, ['default', 'plan'], 'plan');
    rig.event(context(100));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('100%'), findsOneWidget);
  });

  testWidgets('the actions button is a round 40 x 40', (t) async {
    await rig.open(t, events: [session(title: 'x')]);
    expect(
      t.getSize(find.byType(PopupMenuButton<Object?>)),
      const Size(40, 40),
    );
  });
}
