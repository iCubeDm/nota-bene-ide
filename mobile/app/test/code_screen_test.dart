import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/code.dart';
import 'package:nb_app/chat/code_screen.dart';
import 'package:nb_app/main.dart';

Future<void> show(WidgetTester t, Widget w) async {
  await t.pumpWidget(NbApp(home: Scaffold(body: w)));
  await t.pumpAndSettle();
}

void main() {
  testWidgets('a code block opens full screen with language and line count', (
    t,
  ) async {
    await show(t, const CodeBlock('a = 1\nb = 2\nc = 3\n', lang: 'python'));
    await t.tap(find.byTooltip('Open full screen'));
    await t.pumpAndSettle();
    expect(find.byType(CodeScreen), findsOneWidget);
    expect(find.text('python'), findsWidgets);
    expect(find.text('3 lines'), findsOneWidget);
  });

  testWidgets('line numbers are 1..n in a non-selectable column', (t) async {
    await show(t, const CodeScreen(code: 'a\nb\nc\nd', lang: null));
    for (final n in ['1', '2', '3', '4']) {
      expect(find.text(n), findsOneWidget);
    }
    expect(find.text('5'), findsNothing);
    final col = find.ancestor(
      of: find.text('1'),
      matching: find.byType(SelectionContainer),
    );
    expect(col, findsWidgets);
    final disabled = t
        .widgetList<SelectionContainer>(col)
        .any((s) => s.registrar == null);
    expect(disabled, isTrue);
  });

  testWidgets('a long line does not wrap', (t) async {
    final line = 'x' * 300;
    await show(t, CodeScreen(code: line, lang: null));
    final rich = t
        .widgetList<RichText>(find.byType(RichText))
        .where((r) => r.text.toPlainText() == line);
    expect(rich, isNotEmpty);
    expect(rich.every((r) => !r.softWrap), isTrue);
  });

  testWidgets('copy puts the whole code on the clipboard; close pops', (
    t,
  ) async {
    String? copied;
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      },
    );
    addTearDown(
      () => t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await show(t, const CodeBlock('a\nb', lang: 'js'));
    await t.tap(find.byTooltip('Open full screen'));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Copy'));
    expect(copied, 'a\nb');
    await t.tap(find.byTooltip('Close'));
    await t.pumpAndSettle();
    expect(find.byType(CodeScreen), findsNothing);
  });

  testWidgets('the block and the full screen copy the same text', (t) async {
    final copied = <String>[];
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );
    addTearDown(
      () => t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await show(t, const CodeBlock('a\nb\n', lang: 'js'));
    await t.tap(find.byTooltip('Copy'));
    await t.tap(find.byTooltip('Open full screen'));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Copy'));
    expect(copied, ['a\nb', 'a\nb']);
  });
}
