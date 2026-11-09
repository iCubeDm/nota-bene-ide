import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/files/file_screen.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/fakes.dart';
import 'support/rig.dart';

const plan =
    '# Plan\n\nThe cache is read once. Then the cache is written.\n\nA last line.';

/// The screen position of the [nth] occurrence of [word] in the rendered paragraphs.
Offset wordAt(WidgetTester t, String word, {int nth = 0}) {
  var seen = 0;
  for (final p in t.renderObjectList<RenderParagraph>(find.byType(RichText))) {
    final text = p.text.toPlainText();
    for (var i = text.indexOf(word); i != -1; i = text.indexOf(word, i + 1)) {
      if (seen++ < nth) continue;
      final box = p
          .getBoxesForSelection(
            TextSelection(baseOffset: i, extentOffset: i + word.length),
          )
          .first;
      return p.localToGlobal(box.toRect().center);
    }
  }
  throw StateError('no $word');
}

Future<Rig> openFile(
  WidgetTester t, {
  String body = plan,
  int status = 200,
  List<Map<String, Object?>> comments = const [],
  String path = 'docs/plan.md',
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
  r.ch.onHttp = (port, method, p) async => answer(status, body);
  r.event({'kind': 'comments', 'items': comments});
  await t.pumpAndSettle();
  final nav = Navigator.of(t.element(find.byType(Scaffold).first));
  nav.push(
    MaterialPageRoute<void>(
      builder: (_) => FileScreen(tab: r.tab!, path: path),
    ),
  );
  await t.pumpAndSettle();
  return r;
}

Map<String, Object?> lastComments(Rig r) =>
    r.sent.lastWhere((m) => m['type'] == 'comments');

void main() {
  testWidgets('the file is read through the window and shown', (t) async {
    final r = await openFile(t);
    expect(r.ch.requests, contains('GET /file?path=docs%2Fplan.md'));
    expect(find.textContaining('The cache is read once.'), findsOneWidget);
    expect(find.text('plan.md'), findsOneWidget, reason: 'the title');
    r.dispose();
  });

  testWidgets('select a word, Comment, pick a label, write, save', (t) async {
    final r = await openFile(t);
    await t.longPressAt(wordAt(t, 'written'));
    await t.pumpAndSettle();
    await t.tap(find.text('Comment'));
    await t.pumpAndSettle();
    expect(
      find.textContaining('written'),
      findsWidgets,
      reason: 'the quote in the sheet',
    );
    await t.ensureVisible(find.textContaining('Verify this'));
    await t.pumpAndSettle();
    await t.tap(find.textContaining('Verify this'));
    await t.enterText(find.byType(TextField), 'really?');
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final items = lastComments(r)['items'] as List;
    final c = Comment.fromJson((items.single as Map).cast());
    final a = c.anchor as TextAnchor;
    expect(a.quote, 'written');
    expect(a.prefix, endsWith('Then the cache is '));
    expect(a.suffix, startsWith('. A last line.'));
    expect((a.source as AnchorSourceFile).path, 'docs/plan.md');
    expect(c.label, QuickLabelId.verify);
    expect(c.text, 'really?');
    r.dispose();
  });

  testWidgets('the second of a repeated word is anchored there', (t) async {
    final r = await openFile(t);
    await t.longPressAt(wordAt(t, 'cache', nth: 1));
    await t.pumpAndSettle();
    await t.tap(find.text('Comment'));
    await t.pumpAndSettle();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final c = Comment.fromJson(
      ((lastComments(r)['items'] as List).single as Map).cast(),
    );
    final a = c.anchor as TextAnchor;
    expect(a.quote, 'cache');
    expect(a.prefix, endsWith('read once. Then the '));
    r.dispose();
  });

  testWidgets('a comment of the file is highlighted; tap edits it', (t) async {
    const text =
        'Plan The cache is read once. Then the cache is written. A last line.';
    final start = text.indexOf('read once');
    final r = await openFile(
      t,
      comments: [
        {
          'id': 'k1',
          'text': 'why once?',
          'status': 'pending',
          'createdAt': 1,
          'anchor': {
            'source': {'kind': 'file', 'path': 'docs/plan.md'},
            'start': start,
            'end': start + 9,
            'quote': 'read once',
            'prefix': text.substring(start - 13, start),
            'suffix': text.substring(start + 9, start + 20),
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
    expect(marked.join(), 'read once');
    await t.tapAt(wordAt(t, 'once'));
    await t.pumpAndSettle();
    expect(
      find.text('why once?'),
      findsOneWidget,
      reason: 'the sheet edits it',
    );
    await t.tap(find.text('Delete comment'));
    await t.pumpAndSettle();
    expect(lastComments(r)['items'], isEmpty);
    r.dispose();
  });

  for (final (status, body, path, shown) in [
    (404, 'not found', 'docs/plan.md', 'This file is not there'),
    (403, 'outside project', 'docs/plan.md', 'outside the project'),
    (200, 'x' * (2 * 1024 * 1024 + 1), 'docs/plan.md', 'too large'),
    (200, 'binary', 'img/a.png', 'Only Markdown files'),
  ]) {
    testWidgets('$status $path shows its state', (t) async {
      final r = await openFile(t, status: status, body: body, path: path);
      expect(find.textContaining(shown), findsOneWidget);
      r.dispose();
    });
  }
}
