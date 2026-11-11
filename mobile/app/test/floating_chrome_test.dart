import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart' show HitTestResult;
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comment_strip.dart';
import 'package:nb_app/comments/comments_pane.dart';
import 'package:nb_app/ui/blur_band.dart';
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
    Size size = const Size(400, 800),
    FakeViewPadding side = FakeViewPadding.zero,
  }) async {
    t.view.physicalSize = size;
    t.view.devicePixelRatio = 1;
    final pad = FakeViewPadding(
      top: 24,
      bottom: 16,
      left: side.left,
      right: side.right,
    );
    t.view.padding = pad;
    t.view.viewPadding = pad;
    addTearDown(t.view.reset);
    await r.open(t, events: events);
  }

  Finder feed() => find.byKey(const ValueKey('feed'));

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
    expect(p.bottom, closeTo(800 - composer + blurFade + 8 + 56, 0.5));
    // at the end the newest message is above the field
    // and clear of the blur's fade above the field
    expect(
      t.getBottomLeft(find.text('message 39')).dy,
      lessThanOrEqualTo(composer - blurFade),
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

  testWidgets('each band is one group of filters, the far end unblurred', (
    t,
  ) async {
    await open(t, events: many(3));
    int filters(String k) => find
        .descendant(
          of: find.byKey(ValueKey(k)),
          matching: find.byType(BackdropFilter),
        )
        .evaluate()
        .length;
    expect(filters('blur-top'), 2);
    // the bottom's blur grows in many small steps, so none shows as a strip
    expect(filters('blur-bottom'), 9);
  });

  testWidgets('the solid parts of the bands take the taps', (t) async {
    await open(t, events: many(3));
    bool absorbed(String k, Offset at) {
      final hit = HitTestResult();
      t.binding.hitTestInView(hit, at, t.view.viewId);
      final target = t.renderObject(find.byKey(ValueKey(k)));
      return hit.path.any((e) => e.target == target);
    }

    // the gap between the back button and the pill; the left margin of the field
    expect(absorbed('band-solid-top', const Offset(52, 24 + 28)), isTrue);
    final field = t.getTopLeft(find.byKey(const ValueKey('composer'))).dy;
    expect(absorbed('band-solid-bottom', Offset(2, field + 30)), isTrue);
    // the fade zone above the field is the feed's
    expect(absorbed('band-solid-bottom', Offset(200, field - 10)), isFalse);
  });

  testWidgets(
    'a tap in the gap between the header pills misses the row under it',
    (t) async {
      await open(t, events: many(2));
      for (var i = 0; i < 20; i++) {
        r.tab!.comments.add(
          c(
                'c$i',
                'quote $i',
                '',
                source: const AnchorSourceMessage(id: 'u0'),
              ).anchor
              as TextAnchor,
          'note $i',
          null,
        );
      }
      await t.tap(find.text('Comments'));
      await t.pumpAndSettle();
      await t.drag(find.byType(CommentsPane), const Offset(0, -300));
      await t.pumpAndSettle();
      final strip = find.byKey(const ValueKey('strip-current'));
      final before = t.getCenter(strip).dx;
      await t.tapAt(const Offset(52, 24 + 28));
      await t.pumpAndSettle();
      // still on Comments: the row under the gap was not hit
      expect(t.getCenter(strip).dx, before);
      // a row below the band is hit and goes to the chat
      await t.tapAt(const Offset(200, cover + 40));
      await t.pumpAndSettle();
      expect(t.getCenter(strip).dx, isNot(before));
    },
  );

  testWidgets('the compaction bar sits above the field', (t) async {
    await open(t, events: many(3));
    r.event({
      'kind': 'agent',
      'e': {'t': 'compacting'},
      'ts': 2,
    });
    await t.pump(const Duration(milliseconds: 100));
    await t.pump(const Duration(milliseconds: 100));
    final bar = find.byType(LinearProgressIndicator);
    expect(bar, findsOneWidget);
    final field = t.getTopLeft(find.byKey(const ValueKey('composer'))).dy;
    expect(t.getBottomLeft(bar).dy, lessThanOrEqualTo(field));
  });

  testWidgets('the side insets keep the field and the feed off the cutout', (
    t,
  ) async {
    await open(
      t,
      events: many(3),
      side: const FakeViewPadding(left: 40, right: 20),
    );
    final field = t.getRect(find.byKey(const ValueKey('composer')));
    expect(field.left, greaterThanOrEqualTo(40));
    expect(field.right, lessThanOrEqualTo(380));
    final p = padding(t);
    expect((p.left, p.right), (40, 20));
  });

  testWidgets('wide: Comments keeps the status bar clear without a header', (
    t,
  ) async {
    await open(t, size: const Size(1000, 600));
    r.tab!.comments.add(
      c('x', 'quoted words', '').anchor as TextAnchor,
      'note',
      null,
    );
    await t.pumpAndSettle();
    final list = find.descendant(
      of: find.byType(CommentsPane),
      matching: find.byType(ListView),
    );
    expect(t.getTopLeft(list).dy, 24);
  });

  testWidgets('the band grows with a comment strip and the feed follows', (
    t,
  ) async {
    await open(t, events: many(3));
    final before = padding(t).bottom;
    r.tab!.comments.add(
      c('x', 'quoted words', '').anchor as TextAnchor,
      'note',
      null,
    );
    await t.pumpAndSettle();
    final strip = t.getTopLeft(find.byType(CommentStrip)).dy;
    expect(padding(t).bottom, greaterThan(before));
    expect(
      t.getBottomLeft(find.text('message 2')).dy,
      lessThanOrEqualTo(strip - blurFade),
    );
  });

  testWidgets('Stop does not cover the last message', (t) async {
    await open(t, events: many(3));
    final stop = find.byKey(const ValueKey('stop'));
    expect(stop, findsOneWidget);
    expect(
      t.getBottomLeft(find.text('message 2')).dy,
      lessThanOrEqualTo(t.getTopLeft(stop).dy),
    );
  });

  testWidgets('the floating paperclip does not cover the last message', (
    t,
  ) async {
    await open(
      t,
      events: [
        ...many(3),
        {
          'kind': 'agent',
          'e': {
            't': 'turn-end',
            'stop': 'done',
            'secs': 1,
            'answers': 'all',
            'queued': 0,
          },
          'ts': 9,
        },
      ],
    );
    expect(r.tab!.busy, isFalse);
    final composer = t.getTopLeft(find.byKey(const ValueKey('composer'))).dy;
    final idle = padding(t).bottom;
    await t.enterText(find.byType(TextField), 'draft');
    await t.pumpAndSettle();
    final clip = find.byKey(const ValueKey('attach-floating'));
    expect(clip, findsOneWidget);
    // the same room Stop takes
    expect(padding(t).bottom, idle + 56);
    expect(t.getTopLeft(clip).dy, lessThan(composer));
    expect(
      t.getBottomLeft(find.text('message 2')).dy,
      lessThanOrEqualTo(t.getTopLeft(clip).dy),
    );
    await t.enterText(find.byType(TextField), '');
    await t.pumpAndSettle();
    expect(padding(t).bottom, idle);
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
