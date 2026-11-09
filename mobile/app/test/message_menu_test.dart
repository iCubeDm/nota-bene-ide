import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/chat_anchor.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/rig.dart';

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  const reply = '# Plan\n\nFirst **bold** line\nsecond line';

  Future<void> openChat(WidgetTester t) => r.open(
    t,
    events: [
      {'kind': 'user', 'id': 'u1', 'text': 'Hello there\nsecond', 'ts': 1},
      agent({'t': 'message', 'id': 'a1', 'text': reply}),
    ],
  );

  Future<void> hold(WidgetTester t, Finder f) async {
    await t.longPress(f);
    await t.pumpAndSettle();
  }

  Finder menuEntry(String s) => find.text(s);

  testWidgets(
    'long-press on a reply: five labels, the more button and the menu',
    (t) async {
      await openChat(t);
      await hold(t, find.textContaining('First'));
      final five = [
        for (final l in quickLabels)
          if ({
            QuickLabelId.looksGood,
            QuickLabelId.fire,
            QuickLabelId.clarify,
            QuickLabelId.verify,
            QuickLabelId.outOfScope,
          }.contains(l.id))
            l,
      ];
      expect(
        [for (final l in five) l.id.name],
        ['looksGood', 'fire', 'clarify', 'verify', 'outOfScope'],
      );
      final bar = find.byKey(const ValueKey('labels'));
      for (final l in five) {
        expect(
          find.descendant(of: bar, matching: find.text(l.emoji)),
          findsOneWidget,
        );
      }
      expect(
        find.descendant(
          of: bar,
          matching: find.text(
            quickLabels.firstWhere((l) => l.id == QuickLabelId.example).emoji,
          ),
        ),
        findsNothing,
      );
      for (final s in ['Comment', 'Select text', 'Copy', 'Reply']) {
        expect(menuEntry(s), findsOneWidget);
      }
      await t.tap(find.byKey(const ValueKey('labels-more')));
      await t.pumpAndSettle();
      for (final l in quickLabels) {
        expect(
          find.descendant(of: bar, matching: find.text(l.emoji)),
          findsOneWidget,
        );
      }
    },
  );

  testWidgets('an emoji comments the whole message with that label', (t) async {
    await openChat(t);
    await hold(t, find.textContaining('First'));
    await t.tap(find.text(quickLabels[1].emoji));
    await t.pumpAndSettle();
    final c = r.tab!.comments.all.single;
    final a = c.anchor as TextAnchor;
    final text = chatText(r.tab!.feed.items.last).text;
    expect((c.label, c.text), (QuickLabelId.fire, ''));
    expect((a.start, a.end, a.quote), (0, text.length, text));
    expect((a.source as AnchorSourceMessage).id, 'a1');
    expect(find.byKey(const ValueKey('labels')), findsNothing);
  });

  testWidgets('Comment opens the sheet with the message and saves', (t) async {
    await openChat(t);
    await hold(t, find.textContaining('Hello'));
    await t.tap(menuEntry('Comment'));
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('labels')), findsNothing);
    expect(find.textContaining('Hello there'), findsWidgets);
    await t.enterText(find.byType(TextField).last, 'why this?');
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final c = r.tab!.comments.all.single;
    final a = c.anchor as TextAnchor;
    final text = chatText(r.tab!.feed.items.first).text;
    expect(c.text, 'why this?');
    expect((a.start, a.end), (0, text.length));
    expect((a.source as AnchorSourceMessage).id, 'u1');
  });

  testWidgets('the sheet quotes a long message cut, the anchor keeps it', (
    t,
  ) async {
    final long = List.filled(60, 'word').join(' ');
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': long, 'ts': 1},
      ],
    );
    await hold(t, find.textContaining('word word'));
    await t.tap(menuEntry('Comment'));
    await t.pumpAndSettle();
    expect(find.text('${long.substring(0, 200)}…'), findsOneWidget);
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    expect((r.tab!.comments.all.single.anchor as TextAnchor).quote, long);
  });

  testWidgets('Copy puts the Markdown source on the clipboard', (t) async {
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
    await openChat(t);
    await hold(t, find.textContaining('First'));
    await t.tap(menuEntry('Copy'));
    await t.pumpAndSettle();
    expect(copied, reply);
    expect(find.byKey(const ValueKey('labels')), findsNothing);
  });

  testWidgets('Reply quotes every line into the draft and focuses it', (
    t,
  ) async {
    await openChat(t);
    await hold(t, find.textContaining('First'));
    await t.tap(menuEntry('Reply'));
    await t.pumpAndSettle();
    final field = t.widget<TextField>(find.byType(TextField));
    expect(
      field.controller!.text,
      '> # Plan\n> \n> First **bold** line\n> second line\n\n',
    );
    expect(field.focusNode!.hasFocus, isTrue);
  });

  testWidgets('Reply goes after a draft already typed', (t) async {
    await openChat(t);
    await t.enter('mine');
    await hold(t, find.textContaining('Hello'));
    await t.tap(menuEntry('Reply'));
    await t.pumpAndSettle();
    expect(
      t.widget<TextField>(find.byType(TextField)).controller!.text,
      'mine\n> Hello there\n> second\n\n',
    );
  });

  testWidgets('a streaming reply and a tool line open nothing', (t) async {
    await r.open(
      t,
      events: [
        agent({
          't': 'tool-call',
          'id': 't1',
          'name': 'Bash',
          'input': {'command': 'ls'},
          'sub': false,
        }),
        agent({'t': 'message-start'}),
        agent({'t': 'message-chunk', 'text': 'Still typing'}),
      ],
    );
    await hold(t, find.textContaining('Still typing'));
    expect(menuEntry('Comment'), findsNothing);
    await hold(t, find.text('Bash'));
    expect(menuEntry('Comment'), findsNothing);
  });

  testWidgets('a tap on the scrim closes the menu', (t) async {
    await openChat(t);
    await hold(t, find.textContaining('First'));
    await t.tapAt(const Offset(5, 300));
    await t.pumpAndSettle();
    expect(menuEntry('Comment'), findsNothing);
  });

  testWidgets('back closes the menu and not the chat', (t) async {
    await openChat(t);
    await hold(t, find.textContaining('First'));
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    expect(menuEntry('Comment'), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('the user bubble shows Markdown with breaks and HTML as text', (
    t,
  ) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'a **b**\nc <i>d</i>', 'ts': 1},
      ],
    );
    final rich = t.widget<RichText>(
      find.descendant(
        of: find.byKey(const ValueKey('bubble')),
        matching: find.byType(RichText),
      ),
    );
    final plain = rich.text.toPlainText();
    expect(plain, 'a b\nc <i>d</i>');
  });
}
