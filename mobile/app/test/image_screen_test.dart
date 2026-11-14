import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:nb_app/files/image_screen.dart';
import 'package:nb_app/media/picker.dart';
import 'package:nb_app/media/shapes.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';
import 'support/sheet.dart';

final png = Uint8List.fromList(
  img.encodePng(
    img.Image(width: 200, height: 100)..clear(img.ColorRgb8(200, 30, 30)),
  ),
);
final attachId = 'a' * 64;

HttpAnswer bytes(int status, List<int> b, [Map<String, String> h = const {}]) =>
    (status: status, headers: h, body: Uint8List.fromList(b));

/// Lets the real image decoding, rendering and isolates run, then settles the frames.
Future<void> settleReal(WidgetTester t, [int rounds = 6]) async {
  for (var i = 0; i < rounds; i++) {
    await t.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await t.pump();
  }
  await t.pumpAndSettle();
}

Future<Rig> openImage(
  WidgetTester t, {
  int status = 200,
  List<int>? body,
  int attachStatus = 200,
  List<Map<String, Object?>> comments = const [],
  List<ViewerImage>? items,
  int index = 0,
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
  r.ch.onHttp = (port, method, p) async {
    if (p.startsWith('/file')) {
      return bytes(status, body ?? png, {'etag': 'W/"v1"'});
    }
    if (p == '/attach') {
      return bytes(
        attachStatus,
        utf8.encode(jsonEncode({'id': attachId, 'mediaType': 'image/png'})),
      );
    }
    return bytes(200, utf8.encode('{}'));
  };
  r.event({'kind': 'comments', 'items': comments});
  await t.pumpAndSettle();
  Navigator.of(t.element(find.byType(Scaffold).first)).push(
    MaterialPageRoute<void>(
      builder: (_) => items == null
          ? ImageScreen(tab: r.tab!, path: 'img/shot.png')
          : ImageScreen(tab: r.tab!, items: items, index: index),
    ),
  );
  await settleReal(t, 3);
  return r;
}

List<Map<String, Object?>> commentSets(Rig r) => [
  for (final m in r.sent)
    if (m['type'] == 'comments') m,
];

/// Draws a box from a quarter to three quarters of the picture and opens the sheet.
Future<void> drawAndComment(WidgetTester t, String text) async {
  await t.tap(find.byTooltip('Mark up'));
  await t.pumpAndSettle();
  final box = t.getRect(find.byKey(const ValueKey('markup-surface')));
  final from = box.topLeft + Offset(box.width / 4, box.height / 4);
  await t.dragFrom(from, Offset(box.width / 2, box.height / 2));
  await t.pumpAndSettle();
  await t.tap(find.text('Comment'));
  await t.pumpAndSettle();
  await t.enterText(find.byType(TextField), text);
  await tapSend(t);
  await settleReal(t, 10);
}

/// A streamed `/file` answer: [chunks] are read only as the screen listens; [read] counts them.
HttpStreamAnswer fileStream(
  Rig r,
  Map<String, String> headers,
  List<Uint8List> chunks,
  List<int> read,
) => (
  status: 200,
  headers: headers,
  body: Stream.fromIterable(chunks).map((c) {
    read.add(c.length);
    return c;
  }),
  cancel: () => r.ch.cancels++,
);

void main() {
  testWidgets('a file declared too large is refused without reading it', (
    t,
  ) async {
    final r = await openImage(t);
    Navigator.of(t.element(find.byType(ImageScreen))).pop();
    await settleReal(t, 2);
    final read = <int>[];
    r.ch.cancels = 0;
    r.ch.onHttpStream = (port, method, p) async =>
        fileStream(r, {'content-length': '${40 * 1024 * 1024}'}, [png], read);
    Navigator.of(t.element(find.byType(Scaffold).first)).push(
      MaterialPageRoute<void>(
        builder: (_) => ImageScreen(tab: r.tab!, path: 'img/big.png'),
      ),
    );
    await settleReal(t, 3);
    expect(find.textContaining('too large'), findsOneWidget);
    expect(read, isEmpty);
    expect(r.ch.cancels, 1);
    r.dispose();
  });

  testWidgets('a body past the limit without a length is cut off', (t) async {
    final r = await openImage(t);
    Navigator.of(t.element(find.byType(ImageScreen))).pop();
    await settleReal(t, 2);
    final read = <int>[];
    r.ch.cancels = 0;
    final chunk = Uint8List(8 * 1024 * 1024);
    r.ch.onHttpStream = (port, method, p) async =>
        fileStream(r, {}, List.filled(5, chunk), read);
    Navigator.of(t.element(find.byType(Scaffold).first)).push(
      MaterialPageRoute<void>(
        builder: (_) => ImageScreen(tab: r.tab!, path: 'img/big.png'),
      ),
    );
    await settleReal(t, 3);
    expect(find.textContaining('too large'), findsOneWidget);
    expect(r.ch.cancels, 1);
    r.dispose();
  });

  testWidgets('a box drawn on the image becomes the desktop\'s media comment', (
    t,
  ) async {
    final r = await openImage(t);
    expect(find.byType(RawImage), findsOneWidget);
    await drawAndComment(t, 'this one');
    final calls = r.ch.calls;
    final frame = calls.firstWhere((c) => c.path.endsWith('/frame.jpg'));
    final id = frame.path.split('/')[2];
    expect(frame.method, 'POST');
    expect(frame.headers['content-type'], 'image/jpeg');
    expect(frame.body.sublist(0, 3), [0xff, 0xd8, 0xff]);
    final f = img.decodeJpg(Uint8List.fromList(frame.body))!;
    expect((f.width, f.height), (200, 100), reason: 'the natural size');
    expect(
      calls.map((c) => '${c.method} ${c.path}'),
      containsAllInOrder([
        'POST /marks/$id/frame.jpg',
        'POST /marks/$id/layer.png',
        'POST /attach',
      ]),
    );
    final added = (commentSets(r).last['items'] as List).single as Map;
    expect(added['id'], id);
    expect(added['text'], 'this one');
    expect(added['images'], [attachId]);
    expect(added['genImages'], 1);
    final a = added['anchor'] as Map;
    expect(a['kind'], 'media');
    expect(a['source'], {'kind': 'file', 'path': 'img/shot.png'});
    expect((a['width'], a['height'], a['version']), (200, 100, 'W/"v1"'));
    expect(a['shapes'], [
      {
        'kind': 'rect',
        'color': '#ff3b30',
        'x': 0.25,
        'y': 0.25,
        'w': 0.5,
        'h': 0.5,
      },
    ]);
    expect(r.tab!.fileVersions['img/shot.png'], 'W/"v1"');
    expect(find.byTooltip('Mark up'), findsOneWidget, reason: 'marking ends');
    r.dispose();
  });

  testWidgets('a refused attach removes the files, adds nothing and says so', (
    t,
  ) async {
    final r = await openImage(t, attachStatus: 500);
    await drawAndComment(t, 'x');
    final id = r.ch.calls
        .firstWhere((c) => c.path.endsWith('/frame.jpg'))
        .path
        .split('/')[2];
    expect(r.ch.requests.last, 'DELETE /marks/$id');
    expect(commentSets(r), isEmpty);
    expect(find.textContaining('could not be saved'), findsOneWidget);
    expect(find.text('Undo'), findsNothing);
    expect(find.byTooltip('Undo'), findsOneWidget, reason: 'the drawing stays');
    r.dispose();
  });

  for (final (name, status, body, text) in [
    ('missing', 404, <int>[], 'not there'),
    ('outside', 403, <int>[], 'outside the project'),
    ('too large', 200, Uint8List(32 * 1024 * 1024 + 1), 'over 32 MB'),
    ('not an image', 200, utf8.encode('hello'), 'could not be shown'),
  ]) {
    testWidgets('a file $name shows its state', (t) async {
      final r = await openImage(t, status: status, body: body);
      expect(find.textContaining(text), findsOneWidget);
      expect(find.byTooltip('Mark up'), findsNothing);
      r.dispose();
    });
  }

  testWidgets('the image\'s comments are numbered as in the strip', (t) async {
    Map<String, Object?> media(String id, {String path = 'img/shot.png'}) => {
      'id': id,
      'anchor': {
        'kind': 'media',
        'source': {'kind': 'file', 'path': path},
        'width': 200,
        'height': 100,
        'shapes': [
          {
            'kind': 'arrow',
            'color': '#ffffff',
            'x1': 0,
            'y1': 0,
            'x2': 1,
            'y2': 1,
          },
        ],
      },
      'text': 't',
      'status': 'pending',
      'createdAt': 1,
      'images': [attachId],
      'genImages': 1,
    };
    final r = await openImage(
      t,
      comments: [
        media('m1', path: 'img/other.png'),
        media('m2'),
      ],
    );
    expect(shownMarks(r.tab!, 'img/shot.png').map((m) => m.n), [2]);
    r.dispose();
  });

  final three = [
    for (final n in ['a', 'b', 'c']) ViewerImage.file('img/$n.png'),
  ];

  testWidgets('three images opened at the second say 2 / 3 and swipe on', (
    t,
  ) async {
    final r = await openImage(t, items: three, index: 1);
    expect(find.text('2 / 3'), findsOneWidget);
    expect(find.text('b.png'), findsOneWidget);
    await t.fling(find.byType(PageView), const Offset(-400, 0), 1500);
    await settleReal(t, 4);
    expect(find.text('3 / 3'), findsOneWidget);
    expect(find.text('c.png'), findsOneWidget);
    r.dispose();
  });

  testWidgets('only the current image and its neighbours stay decoded', (
    t,
  ) async {
    final five = [
      for (final n in ['a', 'b', 'c', 'd', 'e']) ViewerImage.file('img/$n.png'),
    ];
    final r = await openImage(t, items: five);
    int reads(String n) =>
        r.ch.requests.where((q) => q == 'GET /file?path=img%2F$n.png').length;
    for (var i = 0; i < 4; i++) {
      await t.fling(find.byType(PageView), const Offset(-400, 0), 1500);
      await settleReal(t, 4);
    }
    expect(find.text('5 / 5'), findsOneWidget);
    expect(
      [
        for (final n in ['a', 'b', 'c', 'd', 'e']) reads(n),
      ],
      [1, 1, 1, 1, 1],
    );
    // back to the third: the pages left behind (a, b, c) were let go, so c is read again as it comes back
    await t.fling(find.byType(PageView), const Offset(400, 0), 1500);
    await settleReal(t, 4);
    await t.fling(find.byType(PageView), const Offset(400, 0), 1500);
    await settleReal(t, 4);
    expect(find.text('3 / 5'), findsOneWidget);
    expect(reads('c'), 2);
    expect(reads('b'), 1); // let go too, read again only when it is shown
    expect(reads('d'), 1);
    expect(reads('e'), 1);
    expect(reads('a'), 1);
    r.dispose();
  });

  testWidgets('a swipe down at scale 1 closes the viewer', (t) async {
    final r = await openImage(t);
    await t.fling(find.byType(RawImage), const Offset(0, 400), 1500);
    await settleReal(t, 4);
    expect(find.byType(ImageScreen), findsNothing);
    r.dispose();
  });

  testWidgets('a swipe down on a zoomed image pans and does not close', (
    t,
  ) async {
    final r = await openImage(t);
    t
        .widget<InteractiveViewer>(find.byType(InteractiveViewer))
        .transformationController!
        .value = Matrix4.diagonal3Values(
      3,
      3,
      1,
    );
    await t.pump();
    await t.fling(find.byType(RawImage), const Offset(0, 400), 1500);
    await settleReal(t, 4);
    expect(find.byType(ImageScreen), findsOneWidget);
    r.dispose();
  });

  double scaleOf(WidgetTester t) => t
      .widget<InteractiveViewer>(find.byType(InteractiveViewer).first)
      .transformationController!
      .value
      .getMaxScaleOnAxis();

  /// Two fingers on the picture, apart by [from] and then spread by [by] (one finger stays, as a thumb does), moved
  /// over several frames; they stay down.
  Future<List<TestGesture>> pinch(
    WidgetTester t,
    Offset by, {
    double from = 60,
  }) async {
    final c = t.getCenter(find.byType(PageView));
    final a = await t.startGesture(c - Offset(from / 2, 0), pointer: 1);
    final b = await t.startGesture(c + Offset(from / 2, 0), pointer: 2);
    await t.pump(const Duration(milliseconds: 16));
    for (var i = 1; i <= 10; i++) {
      await b.moveTo(c + Offset(from / 2, 0) + by * (i / 10));
      await t.pump(const Duration(milliseconds: 16));
    }
    return [a, b];
  }

  testWidgets('a two-finger pinch from scale 1 zooms and keeps the page', (
    t,
  ) async {
    final r = await openImage(t, items: three, index: 1);
    expect(scaleOf(t), 1);
    final fingers = await pinch(t, const Offset(200, 120));
    expect(scaleOf(t), greaterThan(2));
    for (final g in fingers) {
      await g.up();
    }
    await settleReal(t, 2);
    expect(scaleOf(t), greaterThan(2));
    expect(find.text('2 / 3'), findsOneWidget);
    expect(find.byType(ImageScreen), findsOneWidget);
    r.dispose();
  });

  testWidgets('a mostly vertical pinch does not close the viewer', (t) async {
    final r = await openImage(t);
    final fingers = await pinch(t, const Offset(30, 200));
    for (final g in fingers) {
      await g.up();
    }
    await settleReal(t, 2);
    expect(find.byType(ImageScreen), findsOneWidget);
    expect(scaleOf(t), greaterThan(2));
    r.dispose();
  });

  testWidgets('a double tap zooms in at the tap and a second one zooms out', (
    t,
  ) async {
    final r = await openImage(t);
    final at = t.getCenter(find.byType(PageView)) + const Offset(40, 10);
    Future<void> doubleTap() async {
      await t.tapAt(at);
      await t.pump(const Duration(milliseconds: 60));
      await t.tapAt(at);
      await settleReal(t, 2);
    }

    await doubleTap();
    expect(scaleOf(t), closeTo(2.5, 0.01));
    await doubleTap();
    expect(scaleOf(t), closeTo(1, 0.01));
    r.dispose();
  });

  /// The shapes of the comment last sent.
  List<Map<String, Object?>> lastShapes(Rig r) => [
    for (final s
        in ((((commentSets(r).last['items'] as List).last as Map)['anchor']
                as Map)['shapes']
            as List))
      (s as Map).cast<String, Object?>(),
  ];

  Future<void> commentMarks(WidgetTester t) async {
    await t.tap(find.text('Comment'));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), 'small');
    await tapSend(t);
    await settleReal(t, 10);
  }

  testWidgets('entering markup keeps the zoom, and a mark lands where drawn', (
    t,
  ) async {
    final r = await openImage(t);
    final fit = t.getRect(find.byType(RawImage));
    final at = t.getCenter(find.byType(PageView)) + const Offset(40, 10);
    await t.tapAt(at);
    await t.pump(const Duration(milliseconds: 60));
    await t.tapAt(at);
    await settleReal(t, 2);
    final zoomed = t.getRect(find.byType(RawImage));
    expect(zoomed.width, greaterThan(fit.width * 2));
    await t.tap(find.byTooltip('Mark up'));
    await t.pumpAndSettle();
    // the toolbar is taller than the actions bar, so only the height of the view changes
    final marking = t.getRect(find.byType(RawImage));
    expect(marking.width, zoomed.width);
    final from = t.getCenter(find.byType(PageView)) - const Offset(40, 20);
    await t.dragFrom(from, const Offset(80, 40));
    await t.pumpAndSettle();
    await commentMarks(t);
    final s = lastShapes(r).single;
    expect(s['kind'], 'rect');
    final k = marking.width / fit.width;
    expect(
      s['x'] as double,
      closeTo((from.dx - marking.left) / marking.width, 0.01),
    );
    expect(s['w'] as double, closeTo(80 / k / fit.width, 0.01));
    r.dispose();
  });

  testWidgets('while marking, two fingers zoom and draw nothing; one draws', (
    t,
  ) async {
    final r = await openImage(t);
    final fit = t.getRect(find.byType(RawImage));
    await t.tap(find.byTooltip('Mark up'));
    await t.pumpAndSettle();
    final fingers = await pinch(t, const Offset(200, 120));
    for (final g in fingers) {
      await g.up();
    }
    await t.pumpAndSettle();
    expect(t.getRect(find.byType(RawImage)).width, greaterThan(fit.width * 2));
    final c = t.getCenter(find.byType(PageView));
    await t.dragFrom(c, const Offset(60, 30));
    await t.pumpAndSettle();
    await commentMarks(t);
    expect(lastShapes(r), hasLength(1), reason: 'the pinch drew no shape');
    r.dispose();
  });

  testWidgets('zoomed, one finger pans and the page stays; at 1 it swipes', (
    t,
  ) async {
    final r = await openImage(t, items: three, index: 1);
    final at = t.getCenter(find.byType(PageView));
    await t.tapAt(at);
    await t.pump(const Duration(milliseconds: 60));
    await t.tapAt(at);
    await settleReal(t, 2);
    expect(scaleOf(t), greaterThan(2));
    await t.fling(find.byType(PageView), const Offset(-100, 0), 1500);
    await settleReal(t, 4);
    expect(find.text('2 / 3'), findsOneWidget);
    await t.tapAt(at);
    await t.pump(const Duration(milliseconds: 60));
    await t.tapAt(at);
    await settleReal(t, 2);
    expect(scaleOf(t), closeTo(1, 0.01));
    await t.fling(find.byType(PageView), const Offset(-400, 0), 1500);
    await settleReal(t, 4);
    expect(find.text('3 / 3'), findsOneWidget);
    r.dispose();
  });

  Offset shiftOf(WidgetTester t) {
    final m = t
        .widget<InteractiveViewer>(find.byType(InteractiveViewer).first)
        .transformationController!
        .value
        .getTranslation();
    return Offset(m.x, m.y);
  }

  /// Moves [g] by [by] in [steps] frames of [ms] each.
  Future<void> glide(
    WidgetTester t,
    TestGesture g,
    Offset by, {
    int steps = 10,
    int ms = 16,
  }) async {
    for (var i = 0; i < steps; i++) {
      await g.moveBy(by / steps.toDouble());
      await t.pump(Duration(milliseconds: ms));
    }
  }

  testWidgets('the last finger of a pinch back to 1 does not drag to close', (
    t,
  ) async {
    final r = await openImage(t);
    final c = t.getCenter(find.byType(PageView));
    final zoom = t
        .widget<InteractiveViewer>(find.byType(InteractiveViewer))
        .transformationController!;
    zoom.value = Matrix4.diagonal3Values(3, 3, 1);
    await t.pump();
    final a = await t.startGesture(c - const Offset(150, 0), pointer: 1);
    final b = await t.startGesture(c + const Offset(150, 0), pointer: 2);
    await t.pump(const Duration(milliseconds: 16));
    await glide(t, b, const Offset(-240, 0));
    expect(scaleOf(t), lessThan(1.05));
    await a.up();
    await t.pump(const Duration(milliseconds: 16));
    await glide(t, b, const Offset(0, 300), steps: 5);
    await b.up();
    await settleReal(t, 4);
    expect(find.byType(ImageScreen), findsOneWidget);
    expect(scaleOf(t), greaterThanOrEqualTo(1));
    r.dispose();
  });

  testWidgets('a second finger during a long drag down does not close', (
    t,
  ) async {
    final r = await openImage(t);
    final c = t.getCenter(find.byType(RawImage));
    final a = await t.startGesture(c, pointer: 1);
    await glide(t, a, const Offset(0, 240), steps: 12, ms: 50);
    expect(t.getCenter(find.byType(RawImage)).dy, greaterThan(c.dy + 125));
    final b = await t.startGesture(c + const Offset(80, 0), pointer: 2);
    await t.pump(const Duration(milliseconds: 16));
    await a.up();
    await b.up();
    await settleReal(t, 4);
    expect(find.byType(ImageScreen), findsOneWidget);
    expect(t.getCenter(find.byType(RawImage)).dy, closeTo(c.dy, 1));
    r.dispose();
  });

  testWidgets('a slow drag down past the threshold closes', (t) async {
    final r = await openImage(t);
    final g = await t.startGesture(t.getCenter(find.byType(RawImage)));
    await glide(t, g, const Offset(0, 160), steps: 8, ms: 100);
    await t.pump(const Duration(milliseconds: 400));
    await g.up();
    await settleReal(t, 4);
    expect(find.byType(ImageScreen), findsNothing);
    r.dispose();
  });

  testWidgets('a short slow drag down snaps back', (t) async {
    final r = await openImage(t);
    final c = t.getCenter(find.byType(RawImage));
    final g = await t.startGesture(c);
    await glide(t, g, const Offset(0, 90), steps: 6, ms: 100);
    await t.pump(const Duration(milliseconds: 400));
    await g.up();
    await settleReal(t, 4);
    expect(find.byType(ImageScreen), findsOneWidget);
    expect(t.getCenter(find.byType(RawImage)).dy, closeTo(c.dy, 1));
    r.dispose();
  });

  testWidgets('a double tap outside the picture zooms on its edge, animated', (
    t,
  ) async {
    final r = await openImage(t);
    final box = t.getRect(find.byType(PageView));
    final tap = box.topLeft + const Offset(4, 4);
    await t.tapAt(tap);
    await t.pump(const Duration(milliseconds: 60));
    await t.tapAt(tap);
    await t.pump();
    await t.pump(const Duration(milliseconds: 100));
    expect(scaleOf(t), inExclusiveRange(1.0, 2.5));
    await settleReal(t, 2);
    expect(scaleOf(t), closeTo(2.5, 0.01));
    final content = containBox(box.size, const Size(200, 100));
    final f = Offset(
      (tap.dx - box.left).clamp(content.left, content.right),
      (tap.dy - box.top).clamp(content.top, content.bottom),
    );
    final want = Offset(
      (f.dx * -1.5).clamp(box.width * -1.5, 0.0),
      (f.dy * -1.5).clamp(box.height * -1.5, 0.0),
    );
    expect(shiftOf(t).dx, closeTo(want.dx, 0.5));
    expect(shiftOf(t).dy, closeTo(want.dy, 0.5));
    expect(
      want.dy,
      lessThan(-1),
    ); // it is the picture's edge, not the corner of the page
    await t.tapAt(tap);
    await t.pump(const Duration(milliseconds: 60));
    await t.tapAt(tap);
    await t.pump();
    await t.pump(const Duration(milliseconds: 100));
    expect(scaleOf(t), inExclusiveRange(1.0, 2.5));
    await settleReal(t, 2);
    expect(scaleOf(t), closeTo(1, 0.01));
    expect(shiftOf(t).distance, lessThan(0.5));
    r.dispose();
  });

  testWidgets('zoomed, one finger pans the picture', (t) async {
    final r = await openImage(t, items: three, index: 1);
    final at = t.getCenter(find.byType(PageView));
    await t.tapAt(at);
    await t.pump(const Duration(milliseconds: 60));
    await t.tapAt(at);
    await settleReal(t, 2);
    final before = shiftOf(t);
    final g = await t.startGesture(at);
    await glide(t, g, const Offset(-60, 0), steps: 6, ms: 100);
    await g.up();
    await settleReal(t, 2);
    expect((shiftOf(t) - before).dx, lessThan(-20));
    expect(find.text('2 / 3'), findsOneWidget);
    r.dispose();
  });

  testWidgets('the bottom actions are Mark up, Comment and Share', (t) async {
    final r = await openImage(t);
    expect(find.byKey(const ValueKey('act-markup')), findsOneWidget);
    expect(find.byKey(const ValueKey('act-comment')), findsOneWidget);
    expect(find.byKey(const ValueKey('act-share')), findsOneWidget);
    r.dispose();
  });

  testWidgets('Comment without a drawing is a comment on the whole image', (
    t,
  ) async {
    final r = await openImage(t);
    await t.tap(find.byKey(const ValueKey('act-comment')));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), 'whole');
    await tapSend(t);
    await settleReal(t, 10);
    final added = (commentSets(r).last['items'] as List).single as Map;
    expect(added['text'], 'whole');
    final a = added['anchor'] as Map;
    expect(a['source'], {'kind': 'file', 'path': 'img/shot.png'});
    expect(a['shapes'], isEmpty);
    r.dispose();
  });

  testWidgets('Share hands the bytes to the system', (t) async {
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(pickChannel, (c) async {
          calls.add(c);
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(pickChannel, null),
    );
    final r = await openImage(t);
    await t.tap(find.byKey(const ValueKey('act-share')));
    await t.pump();
    expect(calls.single.method, 'share');
    final args = calls.single.arguments as Map;
    expect(args['bytes'], png);
    expect(args['mime'], 'image/png');
    expect(args['name'], 'shot.png');
    r.dispose();
  });
}
