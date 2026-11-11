import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/message_field.dart';
import 'package:nb_app/comments/comment_sheet.dart';
import 'package:nb_app/comments/comments.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_protocol/nb_protocol.dart';

double _lum(Color c) {
  double f(double v) =>
      v <= .03928 ? v / 12.92 : math.pow((v + .055) / 1.055, 2.4).toDouble();
  return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b);
}

double _ratio(Color a, Color b) {
  final x = _lum(a), y = _lum(b);
  return (math.max(x, y) + .05) / (math.min(x, y) + .05);
}

Comment _c(String id, {CommentStatus status = CommentStatus.pending}) =>
    Comment(
      id: id,
      anchor: TextAnchor(
        source: const AnchorSourceFile(path: 'a.md'),
        start: 0,
        end: 1,
        quote: 'q',
        prefix: '',
        suffix: '',
      ),
      text: 't',
      status: status,
      createdAt: 1,
    );

void main() {
  group('the message field is visible', () {
    for (final theme in NbTheme.values) {
      test('${theme.id}: it differs from the sheet and from the chat', () {
        final c = theme.colors;
        // the chat's field over its background, the comment sheet's over the sheet (popover)
        expect(
          _ratio(c.fieldOver(c.background), c.background),
          greaterThanOrEqualTo(1.2),
        );
        expect(
          _ratio(c.fieldOver(c.popover), c.popover),
          greaterThanOrEqualTo(1.2),
        );
      });
    }
  });

  group('unsent comments are kept', () {
    test('one added while the tab is not open stays and goes out later', () {
      var open = false;
      var now = DateTime(2026);
      final sent = <ClientMessageComments>[];
      final cs = Comments(
        (m) {
          if (!open) return false;
          sent.add(m as ClientMessageComments);
          return true;
        },
        () => 's',
        now: () => now,
      );
      cs.add(_c('a').anchor, 'hi', null, id: 'a');
      now = now.add(const Duration(minutes: 1));
      expect(cs.pending.map((x) => x.id), ['a']);
      // the server's set, from a connect: without ours, nothing goes out until the tab is open
      cs.apply([_c('d')]);
      expect(cs.pending.map((x) => x.id), ['d', 'a']);
      open = true;
      cs.apply([_c('d')]);
      expect(sent.last.items.map((x) => x.id), ['d', 'a']);
      // once it went out, the overlay expires as before
      now = now.add(const Duration(seconds: 6));
      expect(cs.all.map((x) => x.id), ['d']);
    });

    test('an edit made offline is not undone by the server\'s older copy', () {
      var open = false;
      final cs = Comments((m) => open, () => 's');
      cs.apply([_c('a')]);
      cs.edit('a', 'new', null);
      cs.apply([_c('a')]);
      expect(cs.all.single.text, 'new');
    });
  });

  group('unsent comments and the session', () {
    test('an offline add is not pushed into another session', () {
      var open = false;
      var sid = 's1';
      final sent = <ClientMessageComments>[];
      final cs = Comments((m) {
        if (!open) return false;
        sent.add(m as ClientMessageComments);
        return true;
      }, () => sid);
      cs.add(_c('a').anchor, 'hi', null, id: 'a');
      sid = 's2';
      open = true;
      cs.apply([_c('n')]);
      expect(
        sent.expand((m) => m.items).map((x) => x.id),
        isNot(contains('a')),
      );
      expect(cs.all.map((x) => x.id), ['n']);
    });

    test(
      'an offline edit of a comment deleted elsewhere does not bring it back',
      () {
        var open = false;
        final sent = <ClientMessageComments>[];
        final cs = Comments((m) {
          if (!open) return false;
          sent.add(m as ClientMessageComments);
          return true;
        }, () => 's');
        cs.apply([_c('a'), _c('b')]);
        cs.edit('a', 'new', null);
        open = true;
        cs.apply([_c('b')]);
        expect(
          sent.expand((m) => m.items).map((x) => x.id),
          isNot(contains('a')),
        );
        expect(cs.all.map((x) => x.id), ['b']);
      },
    );

    test('an edit that went out is not overlaid or pushed again', () {
      final sent = <ClientMessageComments>[];
      final cs = Comments((m) {
        sent.add(m as ClientMessageComments);
        return true;
      }, () => 's');
      cs.apply([_c('a')]);
      cs.edit('a', 'new', null);
      final n = sent.length;
      cs.apply([]);
      expect(cs.all, isEmpty);
      expect(sent.length, n);
    });
  });

  group('one count of comments to send', () {
    test('held ones are counted out everywhere', () {
      final cs = Comments((_) => true, () => 's');
      cs.held = () => {'b'};
      cs.apply([_c('a'), _c('b'), _c('x', status: CommentStatus.sent)]);
      expect(cs.pending.length, 2);
      expect(cs.sendable.map((x) => x.id), ['a']);
      expect(cs.toSend, 1);
    });
  });

  testWidgets('a dialog over the sheet is not popped by a late save', (
    t,
  ) async {
    SheetResult? got;
    await t.pumpWidget(
      NbApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async =>
                got = await showCommentSheet(context, quote: 'q'),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await t.tap(find.text('open'));
    await t.pumpAndSettle();
    await t.enterText(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byType(TextField),
      ),
      'typed',
    );
    final send = t.widget<MessageField>(find.byType(MessageField)).onSend;
    final nav = Navigator.of(t.element(find.byType(BottomSheet)));
    unawaited(
      showDialog<void>(
        context: nav.context,
        builder: (_) => const AlertDialog(content: Text('over')),
      ),
    );
    await t.pumpAndSettle();
    send();
    await t.pumpAndSettle(const Duration(milliseconds: 100));
    expect(find.text('over'), findsOneWidget);
    expect(got, isNull);
    nav.pop();
    await t.pumpAndSettle();
    await t.pump(const Duration(milliseconds: 300));
    await t.pumpAndSettle();
    expect(got, isA<SheetSave>());
    expect((got as SheetSave).text, 'typed');
  });
}
