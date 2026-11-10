import 'dart:ui' show SemanticsAction;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show CustomSemanticsAction;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/markdown.dart' show launchLink;
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
    for (final l in quickLabels.take(5)) {
      expect(
        find.descendant(of: bubble, matching: find.text(l.emoji)),
        findsOneWidget,
      );
    }
    expect(
      find.descendant(of: bubble, matching: find.text(quickLabels[5].emoji)),
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

  testWidgets('a paragraph is a button with Comment and Pin actions for '
      'TalkBack', (t) async {
    final h = t.ensureSemantics();
    await open(t);
    final node = t.getSemantics(find.textContaining('The hold').first);
    final data = node.getSemanticsData();
    expect(data.flagsCollection.isButton, isTrue);
    expect(data.hasAction(SemanticsAction.tap), isTrue);
    final actions = data.customSemanticsActionIds
        ?.map((i) => CustomSemanticsAction.getAction(i)?.label)
        .toSet();
    expect(actions, {'Comment', 'Pin'});
    h.dispose();
  });

  testWidgets('the popup stays on screen for a paragraph at the very top', (
    t,
  ) async {
    await open(t, text: 'One short line');
    await t.tap(find.textContaining('One short'));
    await t.pumpAndSettle();
    await t.tap(more);
    await t.pumpAndSettle();
    final screen = t.view.physicalSize / t.view.devicePixelRatio;
    final b = t.getRect(bubble);
    expect(b.top, greaterThanOrEqualTo(0));
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
}
