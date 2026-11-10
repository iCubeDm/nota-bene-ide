import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_route.dart';
import 'package:nb_app/chat/chat_screen.dart';
import 'package:nb_app/comments/comments_pane.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'comments_test.dart' show c;
import 'support/rig.dart';

// The header, the tabs and the message field float over the feed on a blur (gh-206): the feed runs from the screen's top
// to its bottom and keeps the bands clear with its own paddings.
void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  // 8 + 40 + 8 of the header and 40 of the tabs, under a 24 dp status bar
  const cover = 24.0 + 56 + 40;

  Future<void> open(
    WidgetTester t, {
    List<Map<String, Object?>> events = const [],
  }) async {
    t.view.physicalSize = const Size(400, 800);
    t.view.devicePixelRatio = 1;
    t.view.padding = const FakeViewPadding(top: 24, bottom: 16);
    t.view.viewPadding = const FakeViewPadding(top: 24, bottom: 16);
    addTearDown(t.view.reset);
    await r.open(t, events: events);
  }

  Finder feed() => find.descendant(
    of: find.byType(ChatScreen),
    matching: find.byType(ListView),
  );

  EdgeInsets padding(WidgetTester t) =>
      t.widget<ListView>(feed()).padding!.resolve(TextDirection.ltr);

  List<Map<String, Object?>> many(int n) => [
    for (var i = 0; i < n; i++)
      {'kind': 'user', 'id': 'u$i', 'text': 'message $i', 'ts': i},
  ];

  testWidgets('the feed runs behind the header and under the field', (t) async {
    await open(t, events: many(3));
    final box = t.getRect(feed());
    expect(box.top, 0);
    expect(box.bottom, 800);
  });

  testWidgets('the paddings keep the first and last message readable', (
    t,
  ) async {
    await open(t, events: many(40));
    final p = padding(t);
    expect(p.top, cover);
    final composer = t.getTopLeft(find.byKey(const ValueKey('composer'))).dy;
    // the band's own height (field, strip, nav bar) and a little air; a turn in progress adds room for Stop
    expect(r.tab!.busy, isTrue);
    expect(p.bottom, closeTo(800 - composer + 8 + 56, 0.5));
    // at the end the newest message is above the field
    expect(
      t.getBottomLeft(find.text('message 39')).dy,
      lessThanOrEqualTo(composer),
    );
    // at the other end the oldest is under the tabs, not behind them
    await t.fling(feed(), const Offset(0, 3000), 8000);
    await t.pumpAndSettle();
    for (var i = 0; i < 6; i++) {
      await t.fling(feed(), const Offset(0, 3000), 8000);
      await t.pumpAndSettle();
    }
    expect(
      t.getTopLeft(find.text('message 0')).dy,
      greaterThanOrEqualTo(cover),
    );
  });

  testWidgets('the keyboard lifts the field and the feed with it', (t) async {
    await open(t, events: many(3));
    t.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(t.view.resetViewInsets);
    await t.pumpAndSettle();
    final field = t.getRect(find.byKey(const ValueKey('composer')));
    expect(field.bottom, lessThanOrEqualTo(500));
    expect(t.getRect(feed()).bottom, 500);
    expect(
      t.getBottomLeft(find.text('message 2')).dy,
      lessThanOrEqualTo(field.top),
    );
  });

  testWidgets('a new message lands above the field', (t) async {
    await open(t, events: many(40));
    r.event({'kind': 'user', 'id': 'new', 'text': 'fresh words', 'ts': 99});
    await t.pumpAndSettle();
    final field = t.getTopLeft(find.byKey(const ValueKey('composer'))).dy;
    expect(
      t.getBottomLeft(find.text('fresh words')).dy,
      lessThanOrEqualTo(field),
    );
  });

  testWidgets('one blur layer for the top band, one for the bottom', (t) async {
    await open(t, events: many(3));
    expect(
      find.descendant(
        of: find.byType(ChatRoute),
        matching: find.byType(BackdropFilter),
      ),
      findsNWidgets(2),
    );
    expect(find.byKey(const ValueKey('blur-top')), findsOneWidget);
    expect(find.byKey(const ValueKey('blur-bottom')), findsOneWidget);
  });

  testWidgets('the comments pane runs under the header too', (t) async {
    await open(t);
    r.tab!.comments.add(
      c('x', 'quoted words', '').anchor as TextAnchor,
      'note',
      null,
    );
    await t.tap(find.text('Comments'));
    await t.pumpAndSettle();
    final list = find.descendant(
      of: find.byType(CommentsPane),
      matching: find.byType(ListView),
    );
    expect(t.getTopLeft(list).dy, 0);
    expect(
      t.widget<ListView>(list).padding!.resolve(TextDirection.ltr).top,
      cover,
    );
  });
}
