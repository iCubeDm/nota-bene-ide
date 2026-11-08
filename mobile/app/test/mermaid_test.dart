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
}
