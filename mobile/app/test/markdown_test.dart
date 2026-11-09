import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/markdown.dart';
import 'package:nb_app/chat/mermaid.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/theme.dart';

import 'support/mermaid_fake.dart';

Future<void> show(WidgetTester t, String md) async {
  await t.pumpWidget(
    NbApp(
      home: MermaidScope(
        renderer: FakeMermaid(),
        child: Scaffold(body: SingleChildScrollView(child: NbMarkdown(md))),
      ),
    ),
  );
  await t.pumpAndSettle();
}

Iterable<TextSpan> spans(WidgetTester t) sync* {
  for (final r in t.widgetList<RichText>(find.byType(RichText))) {
    final stack = [r.text];
    while (stack.isNotEmpty) {
      final s = stack.removeLast();
      if (s is TextSpan) {
        yield s;
        stack.addAll(s.children ?? const []);
      }
    }
  }
}

void main() {
  testWidgets('a fenced ts block is highlighted', (t) async {
    await show(t, 'Look:\n\n```ts\nconst x = 1;\n```\n');
    final kw = spans(t).where((s) => s.text == 'const');
    expect(kw, isNotEmpty);
    expect(kw.first.style?.color, NbColors.darcula.synKeyword);
    expect(find.byTooltip('Copy'), findsOneWidget);
  });

  testWidgets('inline and display math render', (t) async {
    await show(
      t,
      r'Energy $E = mc^2$ here.'
      '\n\n'
      r'$$\int_0^1 x\,dx$$'
      '\n',
    );
    expect(find.byType(Math), findsNWidgets(2));
  });

  testWidgets('a lone dollar amount stays text', (t) async {
    await show(t, r'It costs $5 and that is all.');
    expect(find.byType(Math), findsNothing);
  });

  testWidgets('bad TeX shows the source', (t) async {
    await show(t, r'$$\frac{1}{$$');
    expect(find.textContaining(r'\frac{1}{'), findsOneWidget);
  });

  testWidgets('headings, lists and links render', (t) async {
    await show(t, '# Title\n\n- one\n- two\n\n[site](https://example.com)');
    expect(find.textContaining('Title'), findsOneWidget);
    expect(find.textContaining('two'), findsOneWidget);
  });
}
