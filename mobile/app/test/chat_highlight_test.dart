import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/anchor.dart';
import 'package:nb_app/comments/chat_anchor.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/rig.dart';
import 'support/sheet.dart';

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  const reply = '# Plan\n\nFirst **bold** line\nsecond line';

  Future<void> openChat(WidgetTester t, {String text = reply}) => r.open(
    t,
    events: [
      {'kind': 'user', 'id': 'u1', 'text': 'Hello there', 'ts': 1},
      agent({'t': 'message', 'id': 'a1', 'text': text}),
    ],
  );

  /// Comment on [quote] (the [nth] occurrence) of the reply a1.
  Comment on(String quote, {int nth = 0, String text = 'why'}) {
    final item = r.tab!.feed.items.last;
    final rt = chatText(item).text;
    var at = -1;
    for (var i = 0; i <= nth; i++) {
      at = rt.indexOf(quote, at + 1);
    }
    return r.tab!.comments.add(
      makeAnchor(chatSource(item)!, rt, at, at + quote.length),
      text,
      null,
    );
  }

  /// The painted spans: the text of each span that has a background.
  List<String> painted(WidgetTester t) {
    final out = <String>[];
    for (final w in t.widgetList<RichText>(find.byType(RichText))) {
      w.text.visitChildren((s) {
        if (s is TextSpan &&
            s.style?.backgroundColor != null &&
            s.text != null) {
          out.add(s.text!);
        }
        return true;
      });
    }
    return out;
  }

  testWidgets('a pending comment paints its passage and carries its number', (
    t,
  ) async {
    await openChat(t);
    on('First');
    final x = on('bold');
    await t.pumpAndSettle();
    expect(painted(t), ['First', 'bold']);
    final c = t.element(find.byType(Scaffold).first);
    final accent = Theme.of(c).extension<NbColors>()!.accent;
    final span = t.widgetList<RichText>(find.byType(RichText)).expand((w) {
      final l = <TextSpan>[];
      w.text.visitChildren((s) {
        if (s is TextSpan && s.text == 'bold') l.add(s);
        return true;
      });
      return l;
    }).single;
    expect(span.style!.backgroundColor, accent.withValues(alpha: 0.28));
    final n = r.tab!.comments.sendable.indexWhere((e) => e.id == x.id) + 1;
    expect(n, 2);
    expect(
      find.descendant(
        of: find.byKey(ValueKey('badge:${x.id}')),
        matching: find.text('$n'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a sent comment is not highlighted', (t) async {
    await openChat(t);
    final x = on('bold');
    r.tab!.comments.apply([
      Comment(
        id: x.id,
        anchor: x.anchor,
        text: 'why',
        status: CommentStatus.sent,
        createdAt: 1,
      ),
    ]);
    await t.pumpAndSettle();
    expect(painted(t), isEmpty);
    expect(find.byKey(ValueKey('badge:${x.id}')), findsNothing);
  });

  testWidgets(
    'a comment whose quote is gone paints nothing, stays in the strip',
    (t) async {
      await openChat(t);
      final item = r.tab!.feed.items.last;
      r.tab!.comments.add(
        makeAnchor(chatSource(item)!, 'gone words here', 0, 5),
        'orphan',
        null,
      );
      await t.pumpAndSettle();
      expect(painted(t), isEmpty);
      expect(r.tab!.comments.sendable, hasLength(1));
      expect(find.text('1 comment to send'), findsOneWidget);
    },
  );

  testWidgets('the same quote twice: the offsets pick the second', (t) async {
    await openChat(t, text: 'echo one\n\necho two');
    on('echo', nth: 1);
    await t.pumpAndSettle();
    expect(painted(t), ['echo']);
    final rt = chatText(r.tab!.feed.items.last);
    final c = r.tab!.comments.all.single.anchor as TextAnchor;
    expect(c.start, rt.text.indexOf('echo', 1));
    // the painted one is in the second block
    final blocks = t.widgetList<RichText>(find.byType(RichText)).toList();
    final first = blocks.firstWhere((w) => w.text.toPlainText() == 'echo one');
    var hit = false;
    first.text.visitChildren((s) {
      if (s is TextSpan && s.style?.backgroundColor != null) hit = true;
      return true;
    });
    expect(hit, isFalse);
  });

  testWidgets('tapping a highlight edits the comment; delete removes it', (
    t,
  ) async {
    await openChat(t);
    final x = on('bold');
    await t.pumpAndSettle();
    await t.tapOnText(find.textRange.ofSubstring('bold').first);
    await t.pumpAndSettle();
    expect(find.text('Delete comment'), findsOneWidget);
    await t.enterText(find.byType(TextField).last, 'changed');
    await tapSend(t);
    await t.pumpAndSettle();
    expect(r.tab!.comments.all.single.text, 'changed');
    await t.tapOnText(find.textRange.ofSubstring('bold').first);
    await t.pumpAndSettle();
    await t.tap(find.text('Delete comment'));
    await t.pumpAndSettle();
    expect(r.tab!.comments.all.where((e) => e.id == x.id), isEmpty);
    expect(painted(t), isEmpty);
  });

  testWidgets('a whole-message comment: badge, no highlight', (t) async {
    await openChat(t);
    final item = r.tab!.feed.items.last;
    final rt = chatText(item).text;
    final x = r.tab!.comments.add(
      makeAnchor(chatSource(item)!, rt, 0, rt.length),
      '',
      null,
    );
    await t.pumpAndSettle();
    expect(painted(t), isEmpty);
    final badge = find.byKey(ValueKey('badge:${x.id}'));
    expect(badge, findsOneWidget);
    final msg = t.getRect(find.textContaining('First').first);
    final b = t.getRect(badge);
    expect(b.top, lessThan(msg.top));
    expect(b.center.dx, greaterThan(msg.center.dx));
  });

  testWidgets('long-press on a highlight still opens the message menu', (
    t,
  ) async {
    await openChat(t);
    on('bold');
    await t.pumpAndSettle();
    await t.longPressAt(t.getCenter(find.textContaining('First').first));
    await t.pumpAndSettle();
    expect(find.text('Reply'), findsOneWidget);
  });

  testWidgets('a comment on one message rebuilds no other item', (t) async {
    await openChat(t);
    final hello = find.byWidgetPredicate(
      (w) => w is RichText && w.text.toPlainText().contains('Hello'),
    );
    final before = t.widget<RichText>(hello);
    on('bold');
    await t.pumpAndSettle();
    final after = t.widget<RichText>(hello);
    expect(identical(before, after), isTrue);
  });

  testWidgets(
    'a comment inside a fenced block highlights there, with its badge',
    (t) async {
      await openChat(t, text: 'Intro words\n\n```\nalpha beta\n  gamma\n```\n');
      final x = on('beta');
      final y = on('gamma');
      await t.pumpAndSettle();
      expect(painted(t), ['beta', 'gamma']);
      final n = r.tab!.comments.sendable.indexWhere((e) => e.id == x.id) + 1;
      expect(
        find.descendant(
          of: find.byKey(ValueKey('badge:${x.id}')),
          matching: find.text('$n'),
        ),
        findsOneWidget,
      );
      expect(find.byKey(ValueKey('badge:${y.id}')), findsOneWidget);
      // a tap on the badge opens the comment
      await t.tap(find.byKey(ValueKey('badge:${x.id}')));
      await t.pumpAndSettle();
      expect(find.text('Delete comment'), findsOneWidget);
    },
  );

  testWidgets('a comment across prose and a fenced block paints both parts', (
    t,
  ) async {
    await openChat(t, text: 'Intro words\n\n```\nalpha beta\n```\n');
    on('words alpha');
    await t.pumpAndSettle();
    expect(painted(t), ['words', 'alpha']);
  });
}
