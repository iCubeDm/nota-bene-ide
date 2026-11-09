import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/code_screen.dart';
import 'package:nb_app/chat/message_selection.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/comments/chat_anchor.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/rig.dart';

/// The screen position of the [nth] occurrence of [word] in the rendered paragraphs.
Offset wordAt(WidgetTester t, String word, {int nth = 0, Finder? within}) {
  var seen = 0;
  for (final p in t.renderObjectList<RenderParagraph>(
    within == null
        ? find.byType(RichText)
        : find.descendant(of: within, matching: find.byType(RichText)),
  )) {
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

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  const reply = '# Plan\n\nFirst **bold** line\nsecond line';

  Future<void> open(WidgetTester t, {String text = reply}) => r.open(
    t,
    events: [
      {'kind': 'user', 'id': 'u1', 'text': 'Hello there', 'ts': 1},
      agent({'t': 'message', 'id': 'a1', 'text': text}),
    ],
  );

  /// Long-press at [at], then "Select text" in the menu.
  Future<void> selectTextAt(WidgetTester t, Offset at) async {
    await t.longPressAt(at);
    await t.pumpAndSettle();
    await t.tap(find.text('Select text'));
    await t.pumpAndSettle();
    // the area replays the long press: it takes a moment to be held
    await t.pump(const Duration(seconds: 1));
    await t.pumpAndSettle();
  }

  testWidgets('Select text: the word under the press is selected, with a '
      'vertical Comment / Copy / Select all toolbar', (t) async {
    await open(t);
    await selectTextAt(t, wordAt(t, 'bold'));
    expect(find.byType(SelectionArea), findsOneWidget);
    final a = t.getTopLeft(find.text('Comment'));
    final b = t.getTopLeft(find.text('Copy'));
    final c = t.getTopLeft(find.text('Select all'));
    expect(b.dy, greaterThan(a.dy));
    expect(c.dy, greaterThan(b.dy));
    expect(b.dx, a.dx);
    expect(c.dx, a.dx);
    expect(find.text('Share'), findsNothing);
    await t.tap(find.text('Comment'));
    await t.pumpAndSettle();
    expect(find.text('bold'), findsWidgets);
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final an = r.tab!.comments.all.single.anchor as TextAnchor;
    expect(an.quote, 'bold');
    expect((an.source as AnchorSourceMessage).id, 'a1');
  });

  testWidgets('the second of two equal words is the one the anchor takes', (
    t,
  ) async {
    await open(t, text: 'cache is read, then the cache is written');
    await selectTextAt(t, wordAt(t, 'cache', nth: 1));
    await t.tap(find.text('Comment'));
    await t.pumpAndSettle();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final an = r.tab!.comments.all.single.anchor as TextAnchor;
    final text = chatText(r.tab!.feed.items.last).text;
    expect(an.quote, 'cache');
    expect(an.start, text.lastIndexOf('cache'));
    expect(an.start, isNot(text.indexOf('cache')));
  });

  testWidgets('Select all takes the whole message', (t) async {
    await open(t);
    await selectTextAt(t, wordAt(t, 'bold'));
    await t.tap(find.text('Select all'));
    await t.pumpAndSettle();
    await t.tap(find.text('Comment'));
    await t.pumpAndSettle();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final an = r.tab!.comments.all.single.anchor as TextAnchor;
    expect(an.quote, chatText(r.tab!.feed.items.last).text);
  });

  testWidgets('a tap outside the message leaves selection mode', (t) async {
    await open(t);
    await selectTextAt(t, wordAt(t, 'bold'));
    expect(find.byType(SelectionArea), findsOneWidget);
    await t.tap(find.text('Hello there'));
    await t.pumpAndSettle();
    expect(find.byType(SelectionArea), findsNothing);
    expect(find.text('Select all'), findsNothing);
  });

  testWidgets('full-screen code of a reply: select, Comment, an anchor in the '
      'message at the code, not at the same word before it', (t) async {
    await open(
      t,
      text: 'Use beta first.\n\n```\nalpha = 1\nbeta = 2\ngamma = 3\n```',
    );
    await t.tap(find.byTooltip('Open full screen'));
    await t.pumpAndSettle();
    expect(find.byType(CodeScreen), findsOneWidget);
    final tip = find.descendant(
      of: find.byType(CodeScreen),
      matching: find.byTooltip('Comment'),
    );
    final button = find.ancestor(of: tip, matching: find.byType(IconButton));
    expect(t.widget<IconButton>(button).onPressed, isNull);
    await t.longPressAt(wordAt(t, 'beta', within: find.byType(CodeScreen)));
    await t.pumpAndSettle();
    await t.tap(tip);
    await t.pumpAndSettle();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final an = r.tab!.comments.all.single.anchor as TextAnchor;
    final text = chatText(r.tab!.feed.items.last).text;
    expect((an.source as AnchorSourceMessage).id, 'a1');
    expect(an.quote, 'beta');
    expect(an.start, text.indexOf('beta', text.indexOf('alpha')));
  });

  /// Opens the [nth] "Open full screen" of the reply, selects [word] there and comments; the saved anchor.
  Future<TextAnchor> commentCode(
    WidgetTester t,
    String word, {
    required int nth,
  }) async {
    await t.tap(find.byTooltip('Open full screen').at(nth));
    await t.pumpAndSettle();
    await t.longPressAt(wordAt(t, word, within: find.byType(CodeScreen)));
    await t.pumpAndSettle();
    await t.tap(
      find.descendant(
        of: find.byType(CodeScreen),
        matching: find.byTooltip('Comment'),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    return r.tab!.comments.all.single.anchor as TextAnchor;
  }

  testWidgets('the second of two equal code blocks: the anchor is in it', (
    t,
  ) async {
    await open(
      t,
      text:
          '```\nalpha = 1\nbeta = 2\n```\n\nand again\n\n'
          '```\nalpha = 1\nbeta = 2\n```',
    );
    final an = await commentCode(t, 'beta', nth: 1);
    final text = chatText(r.tab!.feed.items.last).text;
    expect(an.quote, 'beta');
    expect(an.start, text.lastIndexOf('beta'));
  });

  testWidgets('code that the prose before it also says: the anchor is in the '
      'code', (t) async {
    await open(t, text: 'alpha = 1 beta = 2\n\n```\nalpha = 1\nbeta = 2\n```');
    final an = await commentCode(t, 'beta', nth: 0);
    final text = chatText(r.tab!.feed.items.last).text;
    expect(an.quote, 'beta');
    expect(an.start, text.lastIndexOf('beta'));
  });

  testWidgets('a mermaid block before a code block does not shift which is '
      'which', (t) async {
    await open(
      t,
      text:
          '```mermaid\ngraph TD\nA-->B\n```\n\n'
          '```\nalpha = 1\nbeta = 2\n```\n\n```\nalpha = 1\nbeta = 2\n```',
    );
    final an = await commentCode(t, 'beta', nth: 1);
    final text = chatText(r.tab!.feed.items.last).text;
    expect(an.start, text.lastIndexOf('beta'));
  });

  testWidgets('the message moved between the menu and Select text: the word '
      'under the press is still the one selected, no other menu opens', (
    t,
  ) async {
    await open(t);
    await t.longPressAt(wordAt(t, 'bold'));
    await t.pumpAndSettle();
    // a reply arrives below while the menu is open: this one moves up
    final before = wordAt(t, 'bold', within: find.byType(ListView));
    r.event(
      agent({
        't': 'message',
        'id': 'a2',
        'text': 'Another reply\n\nwith two paragraphs\n\nand a third',
      }),
    );
    await t.pump();
    await t.pump(const Duration(milliseconds: 100));
    expect(wordAt(t, 'bold', within: find.byType(ListView)), isNot(before));
    await t.tap(find.text('Select text'));
    await t.pumpAndSettle();
    await t.pump(const Duration(seconds: 1));
    await t.pumpAndSettle();
    expect(find.byType(SelectionArea), findsOneWidget);
    expect(find.text('Select text'), findsNothing);
    await t.tap(find.text('Comment'));
    await t.pumpAndSettle();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final an = r.tab!.comments.all.single.anchor as TextAnchor;
    expect(an.quote, 'bold');
    expect((an.source as AnchorSourceMessage).id, 'a1');
  });

  testWidgets('a press position outside the message selects all of it', (
    t,
  ) async {
    await open(t);
    final item = r.tab!.feed.items.last;
    await t.pumpWidget(
      NbApp(
        home: Scaffold(
          body: SelectableMessage(
            tab: r.tab!,
            item: item,
            from: const Offset(9000, 9000),
            onDone: () {},
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('Comment'));
    await t.pumpAndSettle();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final an = r.tab!.comments.all.single.anchor as TextAnchor;
    expect(an.quote, chatText(item).text);
  });
}
