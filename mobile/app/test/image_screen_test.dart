import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:nb_app/files/image_screen.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';

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
      builder: (_) => ImageScreen(tab: r.tab!, path: 'img/shot.png'),
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
  await t.tap(find.text('Save'));
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
}
