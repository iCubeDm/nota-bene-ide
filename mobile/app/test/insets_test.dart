import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comment_sheet.dart';
import 'package:nb_app/dictation/whisper_sheet.dart';
import 'package:nb_app/files/file_screen.dart';
import 'package:nb_app/files/files_pane.dart';
import 'package:nb_app/ui/insets.dart';
import 'package:nb_app/usage/usage_screen.dart';

import 'comments_test.dart' show c;
import 'support/fakes.dart';
import 'support/rig.dart';

// The app draws edge to edge: the status and navigation bars overlay it, so a control or the end of a list that sits
// in their strip cannot be reached. Each test gives the view a 24 dp status bar and a 48 dp navigation bar.
void main() {
  const top = 24.0, bottom = 48.0;

  testWidgets('bottomRoom adds the navigation bar to the base', (t) async {
    t.view.devicePixelRatio = 1;
    t.view.viewPadding = const FakeViewPadding(top: top, bottom: bottom);
    t.view.padding = const FakeViewPadding(top: top, bottom: bottom);
    addTearDown(t.view.reset);
    late double room, other;
    await t.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) {
            room = bottomRoom(context);
            other = bottomRoom(context, 32);
            return const SizedBox();
          },
        ),
      ),
    );
    expect(room, 16 + bottom);
    expect(other, 32 + bottom);
  });

  group('on screen', () {
    late Rig r;
    setUp(() => r = Rig());
    tearDown(() => r.dispose());

    Future<void> bars(
      WidgetTester t, {
      Size size = const Size(400, 800),
      double keyboard = 0,
    }) async {
      t.view.physicalSize = size;
      t.view.devicePixelRatio = 1;
      t.view.viewPadding = const FakeViewPadding(top: top, bottom: bottom);
      // the keyboard takes the navigation bar's room: the padding is what is left of the bar
      t.view.padding = FakeViewPadding(
        top: top,
        bottom: keyboard > bottom ? 0 : bottom - keyboard,
      );
      t.view.viewInsets = FakeViewPadding(bottom: keyboard);
      addTearDown(t.view.reset);
    }

    Future<void> session(WidgetTester t, {Map<String, Object?>? hello}) =>
        r.open(
          t,
          hello: hello,
          events: [
            {
              'kind': 'session',
              'id': 's',
              'root': '/home/u/notes',
              'title': 'x',
              'model': 'm',
            },
          ],
        );

    Future<void> push(WidgetTester t, Widget page) async {
      unawaited(
        Navigator.of(
          t.element(find.byType(Scaffold).first),
        ).push(MaterialPageRoute<void>(builder: (_) => page)),
      );
      await t.pumpAndSettle();
    }

    /// Scrolls [list] to its end and returns the lowest bottom of the texts in view.
    Future<double> lowestAtEnd(WidgetTester t, Finder list) async {
      for (var i = 0; i < 12; i++) {
        await t.drag(list, const Offset(0, -2000));
        await t.pumpAndSettle();
      }
      final view = t.view.physicalSize.height;
      var low = 0.0;
      for (final e
          in find
              .descendant(of: list, matching: find.byType(Text))
              .evaluate()) {
        final rect = t.getRect(find.byElementPredicate((x) => x == e));
        if (rect.top < view && rect.bottom > low) low = rect.bottom;
      }
      return low;
    }

    testWidgets('the folder list ends above the navigation bar', (t) async {
      await bars(t, size: const Size(400, 300));
      await session(t);
      r.ch.onHttp = (port, method, path) async => answer(
        200,
        jsonEncode([
          for (var i = 0; i < 30; i++)
            {'name': 'file${i.toString().padLeft(2, '0')}.txt', 'dir': false},
        ]),
      );
      await push(t, Scaffold(body: FilesPane(tab: r.tab!)));
      expect(
        await lowestAtEnd(t, find.byType(ListView).last),
        lessThanOrEqualTo(300 - bottom),
      );
    });

    testWidgets('the comments pane ends above the navigation bar', (t) async {
      await bars(t, size: const Size(400, 300));
      await r.open(t);
      r.event({
        'kind': 'comments',
        'items': [
          for (var i = 0; i < 20; i++)
            jsonDecode(jsonEncode(c('c$i', 'quote $i', 'note $i'))),
        ],
      });
      await t.pumpAndSettle();
      await t.tap(find.text('Comments'));
      await t.pumpAndSettle();
      expect(
        await lowestAtEnd(t, find.byType(ListView).last),
        lessThanOrEqualTo(300 - bottom),
      );
    });

    testWidgets('the usage page ends above the navigation bar', (t) async {
      await bars(t, size: const Size(400, 300));
      await session(t);
      r.ch.onHttp = (port, method, path) async => answer(200, '{}');
      await push(t, UsageScreen(tab: r.tab!));
      final pad = t.widget<ListView>(find.byType(ListView)).padding!;
      expect(
        pad.resolve(TextDirection.ltr).bottom,
        greaterThanOrEqualTo(bottom),
      );
    });

    testWidgets('a long file ends above the navigation bar', (t) async {
      await bars(t, size: const Size(400, 300));
      await session(t);
      r.ch.onHttp = (port, method, path) async =>
          answer(200, List.generate(30, (i) => 'line $i\n').join('\n'));
      await push(t, FileScreen(tab: r.tab!, path: 'docs/plan.md'));
      expect(
        await lowestAtEnd(t, find.byType(ListView).last),
        lessThanOrEqualTo(300 - bottom),
      );
    });

    testWidgets(
      'the Whisper sheet keeps its content above the navigation bar',
      (t) async {
        await bars(t);
        await session(t);
        r.ch.onHttp = (port, method, path) async => answer(500, '');
        unawaited(
          showWhisperSheet(t.element(find.byType(Scaffold).first), r.tab!),
        );
        await t.pumpAndSettle();
        final column = find.descendant(
          of: find.byType(BottomSheet),
          matching: find.byType(Column),
        );
        expect(t.getRect(column.first).bottom, lessThanOrEqualTo(800 - bottom));
      },
    );

    testWidgets('the comment sheet stops under the status bar', (t) async {
      await bars(t, size: const Size(400, 300), keyboard: 150);
      await r.open(t);
      unawaited(
        showCommentSheet(
          t.element(find.byType(Scaffold).first),
          quote: 'q',
          tab: r.tab,
        ),
      );
      await t.pumpAndSettle();
      expect(
        t.getRect(find.byType(BottomSheet)).top,
        greaterThanOrEqualTo(top),
      );
    });

    testWidgets('the message menu stays above the navigation bar', (t) async {
      await bars(t);
      await r.open(
        t,
        events: [
          for (var i = 0; i < 30; i++)
            {'kind': 'user', 'id': 'u$i', 'text': 'message $i', 'ts': i},
        ],
      );
      await t.longPress(find.text('message 29'));
      await t.pumpAndSettle();
      expect(
        t.getRect(find.text('Copy')).bottom,
        lessThanOrEqualTo(800 - bottom),
      );
      expect(t.getRect(find.text('Comment')).top, greaterThanOrEqualTo(top));
    });
  });
}
