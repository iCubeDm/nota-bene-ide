import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart'
    show CustomSemanticsAction, SemanticsNode;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_header.dart';
import 'package:nb_app/chat/markdown.dart' show launchLink;
import 'package:nb_app/chat/message_menu.dart' show barLabels;
import 'package:nb_app/comments/chat_anchor.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/rig.dart';

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  const first =
      'Recording starts after a short hold. Slide left cancels, up locks, and a '
      'release sends it, as in the messengers people already know, with no extra step.';
  const second = 'The hold delay is one constant, so changing it is one line.';
  const third = 'Tests are green.';
  const reply = '$first\n\n$second\n\n$third';

  Future<void> open(WidgetTester t, {String text = reply}) => r.open(
    t,
    events: [
      {'kind': 'user', 'id': 'u1', 'text': 'Hello there', 'ts': 1},
      agent({'t': 'message', 'id': 'a1', 'text': text}),
    ],
  );

  Future<void> tapPara(WidgetTester t, String start) async {
    await t.tap(find.textContaining(start));
    await t.pumpAndSettle();
  }

  final bubble = find.byKey(const ValueKey('para-labels'));
  final bar = find.byKey(const ValueKey('para-bar'));
  final more = find.byKey(const ValueKey('para-more'));
  Finder barButton(String s) =>
      find.descendant(of: bar, matching: find.widgetWithText(InkWell, s));

  testWidgets('a tap on a paragraph targets it: bubble above, bar below, '
      'no scrim', (t) async {
    await open(t);
    expect(bubble, findsNothing);
    await tapPara(t, 'The hold');
    expect(bubble, findsOneWidget);
    expect(bar, findsOneWidget);
    expect(find.byKey(const ValueKey('menu-scrim')), findsNothing);
    final para = t.getRect(find.textContaining('The hold'));
    expect(t.getRect(bubble).bottom, lessThanOrEqualTo(para.top));
    expect(t.getRect(bar).top, greaterThanOrEqualTo(para.bottom));
    expect(t.getRect(bar).height, 48);
    // five quick labels and the chevron
    for (final l in barLabels) {
      expect(
        find.descendant(of: bubble, matching: find.text(l.emoji)),
        findsOneWidget,
      );
    }
    expect(
      find.descendant(
        of: bubble,
        matching: find.text(
          quickLabels.firstWhere((l) => !barLabels.contains(l)).emoji,
        ),
      ),
      findsNothing,
    );
    expect(more, findsOneWidget);
    expect(find.byKey(const ValueKey('para-target:a1:1')), findsOneWidget);
    expect(find.byKey(const ValueKey('para-target:a1:0')), findsNothing);
  });

  testWidgets('a second tap on it, or a tap outside, clears the target', (
    t,
  ) async {
    await open(t);
    await tapPara(t, 'The hold');
    await tapPara(t, 'The hold');
    expect(bubble, findsNothing);
    expect(find.byKey(const ValueKey('para-target:a1:1')), findsNothing);
    await tapPara(t, 'The hold');
    expect(bubble, findsOneWidget);
    await t.tap(find.text('Hello there'));
    await t.pumpAndSettle();
    expect(bubble, findsNothing);
    expect(bar, findsNothing);
  });

  testWidgets('a tap on another paragraph moves the target', (t) async {
    await open(t);
    await tapPara(t, 'The hold');
    // the first line of the paragraph above: the bubble covers only its end
    await t.tapAt(
      t.getTopLeft(find.textContaining('Recording')) + const Offset(20, 8),
    );
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('para-target:a1:1')), findsNothing);
    expect(find.byKey(const ValueKey('para-target:a1:0')), findsOneWidget);
    expect(bubble, findsOneWidget);
  });

  testWidgets('a label comments the paragraph; the snackbar can undo it', (
    t,
  ) async {
    await open(t);
    await tapPara(t, 'The hold');
    await t.tap(
      find.descendant(of: bubble, matching: find.text(quickLabels[2].emoji)),
    );
    await t.pumpAndSettle();
    final c = r.tab!.comments.all.single;
    final a = c.anchor as TextAnchor;
    final text = chatText(r.tab!.feed.items.last).text;
    expect((c.label, c.text), (QuickLabelId.clarify, ''));
    expect(a.quote, second);
    expect(a.start, text.indexOf(second));
    expect(a.end, text.indexOf(second) + second.length);
    expect((a.source as AnchorSourceMessage).id, 'a1');
    expect(bubble, findsNothing);
    expect(
      find.text('${quickLabels[2].emoji} ${quickLabels[2].text['en']} added'),
      findsOneWidget,
    );
    await t.tap(find.text('Undo'));
    await t.pumpAndSettle();
    expect(r.tab!.comments.all, isEmpty);
  });

  testWidgets('the chevron grows the bubble into all eleven, named, and Less '
      'folds it', (t) async {
    await open(t);
    await tapPara(t, 'The hold');
    final before = t.getRect(bubble);
    await t.tap(more);
    await t.pumpAndSettle();
    expect(bubble, findsOneWidget);
    for (final l in quickLabels) {
      expect(
        find.descendant(of: bubble, matching: find.text(l.emoji)),
        findsOneWidget,
      );
      expect(
        find.descendant(of: bubble, matching: find.text(l.text['en']!)),
        findsOneWidget,
      );
    }
    expect(quickLabels, hasLength(11));
    expect(
      find.descendant(of: bubble, matching: find.text('Less')),
      findsOneWidget,
    );
    final after = t.getRect(bubble);
    expect(after.height, greaterThan(before.height));
    expect(after.bottom, before.bottom); // grows upward
    await t.tap(find.descendant(of: bubble, matching: find.text('Less')));
    await t.pumpAndSettle();
    expect(t.getRect(bubble).height, before.height);
    await t.tap(more);
    await t.pumpAndSettle();
    await t.tap(
      find.descendant(of: bubble, matching: find.text(quickLabels[9].emoji)),
    );
    await t.pumpAndSettle();
    expect((r.tab!.comments.all.single).label, quickLabels[9].id);
  });

  testWidgets('Comment opens the sheet with the paragraph as the quote', (
    t,
  ) async {
    await open(t);
    await tapPara(t, 'The hold');
    await t.tap(barButton('Comment'));
    await t.pumpAndSettle();
    expect(bubble, findsNothing);
    expect(find.text(second), findsWidgets);
    await t.enterText(find.byType(TextField).last, 'why one?');
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final c = r.tab!.comments.all.single;
    expect(c.text, 'why one?');
    expect((c.anchor as TextAnchor).quote, second);
  });

  testWidgets('Copy puts the paragraph text on the clipboard and says so', (
    t,
  ) async {
    String? copied;
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String?;
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
    await open(t);
    await tapPara(t, 'The hold');
    await t.tap(barButton('Copy'));
    await t.pumpAndSettle();
    expect(copied, second);
    expect(find.text('Copied'), findsOneWidget);
    expect(bubble, findsNothing);
    expect(r.tab!.comments.all, isEmpty);
  });

  testWidgets('Pin is shown disabled', (t) async {
    await open(t);
    await tapPara(t, 'The hold');
    expect(t.widget<InkWell>(barButton('Pin')).onTap, isNull);
    await t.tap(barButton('Pin'), warnIfMissed: false);
    await t.pumpAndSettle();
    expect(bubble, findsOneWidget);
    expect(r.tab!.comments.all, isEmpty);
  });

  testWidgets('a link keeps its own tap; a code block and a user message '
      'are not targets', (t) async {
    final opened = <Uri>[];
    launchLink = (u) async {
      opened.add(u);
      return true;
    };
    addTearDown(() => launchLink = (u) async => false);
    await open(
      t,
      text:
          'See [the docs](https://example.com/d) now\n\n```\nfinal a = 42;\n```',
    );
    await t.tap(find.textContaining('the docs').first);
    await t.pumpAndSettle();
    expect(opened.single.host, 'example.com');
    expect(bubble, findsNothing);
    await t.tap(find.textContaining('final a').first);
    await t.pumpAndSettle();
    expect(bubble, findsNothing);
    await t.tap(find.text('Hello there'));
    await t.pumpAndSettle();
    expect(bubble, findsNothing);
  });

  testWidgets('a reply that still streams has no targets', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'Hello there', 'ts': 1},
        agent({'t': 'message-start'}),
        agent({'t': 'message-chunk', 'text': 'Still typing this'}),
      ],
    );
    await t.tap(find.textContaining('Still typing'));
    await t.pumpAndSettle();
    expect(bubble, findsNothing);
  });

  testWidgets('long-press keeps the whole-message menu, with no Select text '
      'for a reply', (t) async {
    await open(t);
    await t.longPress(find.textContaining('The hold'));
    await t.pumpAndSettle();
    expect(find.text('Comment'), findsOneWidget);
    expect(find.text('Select text'), findsNothing);
    expect(bubble, findsNothing);
    await t.tapAt(const Offset(2, 2));
    await t.pumpAndSettle();
    await t.longPress(find.text('Hello there'));
    await t.pumpAndSettle();
    expect(find.text('Select text'), findsOneWidget);
  });

  /// The semantics nodes under [n], [n] first.
  Iterable<SemanticsNode> walk(SemanticsNode n) sync* {
    yield n;
    final kids = <SemanticsNode>[];
    n.visitChildren((k) {
      kids.add(k);
      return true;
    });
    for (final k in kids) {
      yield* walk(k);
    }
  }

  testWidgets('a paragraph is a button with a Comment action for TalkBack; '
      'its link stays a node of its own', (t) async {
    final h = t.ensureSemantics();
    await open(t, text: 'See [the docs](https://example.com/d) now\n\nSecond');
    final root =
        t.binding.renderViews.first.owner!.semanticsOwner!.rootSemanticsNode!;
    final nodes = walk(root).toList();
    final button = nodes.firstWhere(
      (n) =>
          n.getSemanticsData().flagsCollection.isButton &&
          (n.getSemanticsData().customSemanticsActionIds ?? []).isNotEmpty,
    );
    final data = button.getSemanticsData();
    expect(data.hasAction(SemanticsAction.tap), isTrue);
    final actions = data.customSemanticsActionIds!
        .map((i) => CustomSemanticsAction.getAction(i)?.label)
        .toSet();
    // Pin has no action until pins exist
    expect(actions, {'Comment'});
    final link = nodes.firstWhere(
      (n) => n.getSemanticsData().flagsCollection.isLink,
    );
    expect(link.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
    expect(identical(link, button), isFalse);
    h.dispose();
  });

  testWidgets('a paragraph right under the header: the popup stays below '
      'the header and on screen', (t) async {
    final many = List.generate(30, (i) => 'Paragraph number $i of many.');
    await open(t, text: many.join('\n\n'));
    // scroll to the oldest end: the first paragraph sits just under the header
    await t.dragFrom(const Offset(200, 300), const Offset(0, 5000));
    await t.pumpAndSettle();
    await t.tap(find.textContaining('Paragraph number 0 '));
    await t.pumpAndSettle();
    await t.tap(more);
    await t.pumpAndSettle();
    final screen = t.view.physicalSize / t.view.devicePixelRatio;
    final header = t.getRect(find.byType(ChatHeader));
    final b = t.getRect(bubble);
    expect(b.top, greaterThanOrEqualTo(header.bottom));
    expect(b.left, greaterThanOrEqualTo(0));
    expect(b.right, lessThanOrEqualTo(screen.width));
    expect(t.getRect(bar).bottom, lessThanOrEqualTo(screen.height));
  });

  testWidgets('a paragraph low in the feed: the bar is kept inside it and '
      'the grid grows upward', (t) async {
    await open(t);
    await tapPara(t, 'Tests are');
    final feed = t.getRect(find.byType(ListView).first);
    expect(t.getRect(bar).bottom, lessThanOrEqualTo(feed.bottom));
    await t.tap(more);
    await t.pumpAndSettle();
    expect(t.getRect(bubble).top, greaterThanOrEqualTo(feed.top));
    expect(
      t.getRect(bubble).bottom,
      lessThanOrEqualTo(t.getRect(find.textContaining('Tests are')).top),
    );
  });

  testWidgets('the comment on a paragraph is painted in the reply with its '
      'number', (t) async {
    await open(t);
    await tapPara(t, 'The hold');
    await t.tap(
      find.descendant(of: bubble, matching: find.text(quickLabels[1].emoji)),
    );
    await t.pumpAndSettle();
    final c = r.tab!.comments.all.single;
    expect(find.byKey(ValueKey('badge:${c.id}')), findsOneWidget);
  });

  testWidgets('a swipe to Files that starts on the target clears it and '
      'leaves no frames running', (t) async {
    await open(t);
    await tapPara(t, 'The hold');
    expect(bubble, findsOneWidget);
    await t.dragFrom(
      t.getCenter(find.textContaining('The hold')) + const Offset(100, 0),
      const Offset(300, 0),
    );
    await t.pumpAndSettle();
    expect(bubble, findsNothing);
    expect(bar, findsNothing);
    expect(t.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('the Undo snackbar goes by itself and floats clear of the '
      'message field', (t) async {
    await open(t);
    await tapPara(t, 'The hold');
    await t.tap(
      find.descendant(of: bubble, matching: find.text(quickLabels[1].emoji)),
    );
    await t.pumpAndSettle(const Duration(milliseconds: 100));
    final snack = find.byType(SnackBar);
    expect(snack, findsOneWidget);
    final field = t.getRect(find.byType(TextField).first);
    final card = find
        .descendant(of: snack, matching: find.byType(Material))
        .first;
    expect(t.getRect(card).overlaps(field), isFalse);
    expect(t.getRect(card).bottom, lessThanOrEqualTo(field.top));
    await t.pump(const Duration(seconds: 5));
    await t.pumpAndSettle();
    expect(snack, findsNothing);
  });

  testWidgets('Android back clears the target and keeps the chat', (t) async {
    await open(t);
    await tapPara(t, 'The hold');
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    expect(bubble, findsNothing);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.byKey(const ValueKey('para-target:a1:1')), findsNothing);
  });
}
