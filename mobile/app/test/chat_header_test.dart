import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_header.dart';
import 'package:nb_app/chat/chat_screen.dart';
import 'package:nb_app/chat/window_tab.dart';
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

  testWidgets('the pill shows the title and the model', (t) async {
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
    expect(find.text('opus'), findsOneWidget);
    expect(find.text('X'), findsOneWidget);
  });

  testWidgets('no title reads untitled', (t) async {
    await rig.open(t, events: [session()]);
    expect(find.text('untitled'), findsOneWidget);
  });

  testWidgets('two limits make two meters, one makes one', (t) async {
    final h = t.ensureSemantics();
    await rig.open(t, events: [session(title: 'x')]);
    expect(find.bySemanticsLabel(RegExp(r'^[57]d? ')), findsNothing);
    rig.event(
      stats({
        'five_hour': {'utilization': 42},
        'seven_day': {'utilization': 7.4},
      }),
    );
    await t.pumpAndSettle();
    expect(find.bySemanticsLabel('5h 42%'), findsOneWidget);
    expect(find.bySemanticsLabel('7d 7%'), findsOneWidget);
    rig.event(
      stats({
        'five_hour': {'utilization': 130},
      }),
    );
    await t.pumpAndSettle();
    expect(find.bySemanticsLabel('5h 100%'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^7d')), findsNothing);
    h.dispose();
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
    expect(
      find.ancestor(of: find.text('Spec work'), matching: find.byType(InkWell)),
      findsNothing,
    );
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
    await t.tap(find.text('untitled'));
    expect(taps, 1);
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
}
