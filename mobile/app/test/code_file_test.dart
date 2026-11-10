import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/code_screen.dart';
import 'package:nb_app/files/text_file_screen.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'file_screen_test.dart' show wordAt;
import 'support/fakes.dart';
import 'support/rig.dart';

const repeated = 'foo(1);\nfoo(1);\nfoo(1);\n';

Future<Rig> open(
  WidgetTester t, {
  String body = repeated,
  List<Map<String, Object?>> comments = const [],
}) async {
  final r = Rig();
  await r.open(
    t,
    events: [
      {
        'kind': 'session',
        'id': 's1',
        'root': '/home/u/notes',
        'title': null,
        'model': null,
      },
    ],
  );
  r.ch.onHttp = (port, method, p) async => answer(200, body);
  r.event({'kind': 'comments', 'items': comments});
  await t.pumpAndSettle();
  Navigator.of(t.element(find.byType(Scaffold).first)).push(
    MaterialPageRoute<void>(
      builder: (_) => TextFileScreen(tab: r.tab!, path: 'src/a.ts'),
    ),
  );
  await t.pumpAndSettle();
  return r;
}

void main() {
  testWidgets('a comment on repeated code anchors where the selection is', (
    t,
  ) async {
    final r = await open(t);
    await t.longPressAt(wordAt(t, 'foo', nth: 2));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Comment'));
    await t.pumpAndSettle();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final items = r.sent.lastWhere((m) => m['type'] == 'comments')['items'];
    final c = Comment.fromJson(((items as List).single as Map).cast());
    final a = c.anchor as TextAnchor;
    expect(a.quote, 'foo');
    // the third foo of `foo(1); foo(1); foo(1);`
    expect(a.start, 16);
    r.dispose();
  });

  testWidgets('the comments of the file are painted over the code', (t) async {
    const text = 'foo(1); foo(1); foo(1);';
    final r = await open(
      t,
      comments: [
        {
          'id': 'k1',
          'text': 'why?',
          'status': 'pending',
          'createdAt': 1,
          'anchor': {
            'source': {'kind': 'file', 'path': 'src/a.ts'},
            'start': 8,
            'end': 15,
            'quote': 'foo(1);',
            'prefix': text.substring(0, 8),
            'suffix': text.substring(15),
          },
        },
      ],
    );
    final marked = <String>[];
    for (final p in t.renderObjectList<RenderParagraph>(
      find.byType(RichText),
    )) {
      p.text.visitChildren((s) {
        if (s is TextSpan &&
            s.style?.backgroundColor != null &&
            s.text != null) {
          marked.add(s.text!);
        }
        return true;
      });
    }
    expect(marked.join(), 'foo(1);');
    r.dispose();
  });

  testWidgets('a comment of a commit\'s diff is not painted on the file', (
    t,
  ) async {
    const text = 'foo(1); foo(1); foo(1);';
    final r = await open(
      t,
      comments: [
        {
          'id': 'k1',
          'text': 'old',
          'status': 'pending',
          'createdAt': 1,
          'anchor': {
            'source': {'kind': 'file', 'path': 'src/a.ts', 'ref': 'abc1234'},
            'start': 8,
            'end': 15,
            'quote': 'foo(1);',
            'prefix': text.substring(0, 8),
            'suffix': text.substring(15),
          },
        },
      ],
    );
    for (final p in t.renderObjectList<RenderParagraph>(
      find.byType(RichText),
    )) {
      p.text.visitChildren((s) {
        expect(s is TextSpan && s.style?.backgroundColor != null, isFalse);
        return true;
      });
    }
    r.dispose();
  });

  testWidgets('a big file builds only the lines near the screen', (t) async {
    final body = [for (var i = 0; i < 5000; i++) 'line $i'].join('\n');
    final r = await open(t, body: body);
    expect(find.byType(CodeScreen), findsOneWidget);
    final rows = t.widgetList(find.textContaining('line ')).length;
    expect(rows, lessThan(100));
    r.dispose();
  });

  testWidgets('a line over 2000 characters is not highlighted', (t) async {
    final long = 'var a = "${'x' * 2100}";';
    final r = await open(t, body: '$long\nvar b = 1;');
    final plain = t
        .widgetList<RichText>(find.byType(RichText))
        .where((w) => w.text.toPlainText() == long);
    expect(plain, isNotEmpty);
    // one span, no colours
    for (final w in plain) {
      var spans = 0;
      w.text.visitChildren((s) {
        spans++;
        return true;
      });
      expect(spans, 1);
    }
    r.dispose();
  });
}
