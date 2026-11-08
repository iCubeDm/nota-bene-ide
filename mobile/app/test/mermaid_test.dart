import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/mermaid.dart';
import 'package:nb_app/main.dart';

import 'support/mermaid_fake.dart';

void main() {
  late FakeMermaid fake;
  setUp(() => fake = FakeMermaid());

  Future<void> show(WidgetTester t, List<String> sources) async {
    await t.pumpWidget(
      NbApp(
        home: MermaidScope(
          renderer: CachedMermaid(fake),
          child: Scaffold(
            body: ListView(
              children: [for (final s in sources) MermaidBlock(s)],
            ),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
  }

  testWidgets('a diagram shows the rendered image', (t) async {
    await show(t, ['flowchart LR\n  A --> B']);
    expect(find.byType(Image), findsOneWidget);
    expect(
      find.textContaining('flowchart'),
      findsNothing,
      reason: 'never the source',
    );
  });

  testWidgets('the same source is drawn once', (t) async {
    await show(t, ['flowchart LR\n  A --> B', 'flowchart LR\n  A --> B']);
    expect(find.byType(Image), findsNWidgets(2));
    expect(fake.calls, hasLength(1));
  });

  testWidgets('a rejected diagram shows the error, not the source', (t) async {
    await show(t, ['flowchart LR\n  A --> ((']);
    expect(find.textContaining('Parse error on line 2'), findsOneWidget);
    expect(find.textContaining('A -->'), findsNothing);
  });

  testWidgets('tap opens the zoomable view', (t) async {
    await show(t, ['flowchart LR\n  A --> B']);
    await t.tap(find.byType(Image));
    await t.pumpAndSettle();
    expect(find.byType(InteractiveViewer), findsOneWidget);
  });

  testWidgets('a diagram whose source grows is drawn again', (t) async {
    Widget app(String src) => NbApp(
      home: MermaidScope(
        renderer: CachedMermaid(fake),
        child: Scaffold(body: MermaidBlock(src)),
      ),
    );
    await t.pumpWidget(app('flutter LR\n  A --> (('));
    await t.pumpAndSettle();
    expect(find.textContaining('Parse error'), findsOneWidget);
    await t.pumpWidget(app('flowchart LR\n  A --> B'));
    await t.pumpAndSettle();
    expect(find.byType(Image), findsOneWidget);
    expect(fake.calls.last, 'flowchart LR\n  A --> B');
  });

  testWidgets('a timeout is not remembered, an error from the page is', (
    t,
  ) async {
    final flaky = _Flaky();
    final c = CachedMermaid(flaky);
    await expectLater(
      c.render('x', dark: true, scale: 1),
      throwsA(isA<MermaidTimeout>()),
    );
    await c.render('x', dark: true, scale: 1);
    expect(flaky.calls, 2);
    await expectLater(
      c.render('bad ((', dark: true, scale: 1),
      throwsA(isA<MermaidError>()),
    );
    await expectLater(
      c.render('bad ((', dark: true, scale: 1),
      throwsA(isA<MermaidError>()),
    );
    expect(flaky.calls, 3);
  });
}

class _Flaky implements MermaidRenderer {
  var calls = 0;
  @override
  Future<MermaidImage> render(
    String source, {
    required bool dark,
    required double scale,
  }) async {
    calls++;
    if (source.contains('((')) throw MermaidError('Parse error');
    if (calls == 1) throw MermaidTimeout();
    return MermaidImage(FakeMermaid.png, 1, 1);
  }

  @override
  Widget? get engine => null;
}
