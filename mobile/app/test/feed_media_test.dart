import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:nb_app/chat/media_card.dart';
import 'package:nb_app/files/image_screen.dart';
import 'package:nb_app/files/video_screen.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';

final png = Uint8List.fromList(
  img.encodePng(
    img.Image(width: 200, height: 100)..clear(img.ColorRgb8(200, 30, 30)),
  ),
);
final idA = 'a' * 64, idB = 'b' * 64;

HttpAnswer answer(int status, [List<int> body = const []]) =>
    (status: status, headers: const {}, body: Uint8List.fromList(body));

/// Lets the real image decoding run, then settles the frames.
Future<void> settleReal(WidgetTester t, [int rounds = 4]) async {
  for (var i = 0; i < rounds; i++) {
    await t.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 60)),
    );
    await t.pump();
  }
}

Map<String, Object?> hello() => {
  'kind': 'hello',
  'protocol': 13,
  'capabilities': Rig.caps(),
  'tmpDirs': ['/tmp'],
};

Map<String, Object?> user(List<String> ids) => {
  'kind': 'user',
  'id': 'u1',
  'text': 'look',
  'ts': 1,
  'historic': true,
  'images': [
    for (final id in ids) {'id': id, 'mediaType': 'image/png', 'label': 'x'},
  ],
};

/// A finished tool call (cards come under finished lines).
List<Map<String, Object?>> tool(
  String name,
  Map<String, Object?> input, [
  String id = 't1',
]) => [
  agent({
    't': 'tool-call',
    'id': id,
    'name': name,
    'input': input,
    'sub': false,
  }),
  agent({'t': 'tool-update', 'id': id, 'text': 'ok', 'isError': false}),
];

/// A chat whose host answers [onHttp], with [events] replayed once it is listening.
Future<Rig> chat(
  WidgetTester t,
  List<Map<String, Object?>> events,
  Future<HttpAnswer> Function(int, String, String) onHttp,
) async {
  final r = Rig();
  await r.open(t, hello: hello());
  r.ch.onHttp = onHttp;
  r.event({'kind': 'replay', 'events': events});
  await t.pumpAndSettle();
  await settleReal(t);
  return r;
}

void main() {
  testWidgets('a user message shows its images fetched from /attach', (
    t,
  ) async {
    final r = await chat(t, [
      user([idA, idB]),
    ], (p, m, path) async => answer(200, png));
    expect(
      r.ch.requests,
      containsAll(['GET /attach/$idA', 'GET /attach/$idB']),
    );
    expect(find.byType(AttachThumb), findsNWidgets(2));
    expect(find.byType(Image), findsNWidgets(2));
    // asked once each for the tab's life, however often the feed rebuilds
    r.event(agent({'t': 'message-chunk', 'text': 'hi'}));
    await t.pumpAndSettle();
    expect(r.ch.requests.where((q) => q.contains(idA)).length, 1);
    r.dispose();
  });

  testWidgets('a tap on a thumbnail opens the viewer on that image', (t) async {
    final r = await chat(t, [
      user([idA, idB]),
    ], (p, m, path) async => answer(200, png));
    await t.tap(find.byType(AttachThumb).last);
    await settleReal(t);
    expect(find.byType(ImageScreen), findsOneWidget);
    expect(t.widget<ImageScreen>(find.byType(ImageScreen)).index, 1);
    r.dispose();
  });

  testWidgets('a tmp image named by a tool shows a card from /tmpimage', (
    t,
  ) async {
    final r = await chat(t, [
      ...tool('Read', {'file_path': '/tmp/x.png'}),
    ], (p, m, path) async => answer(200, png));
    expect(r.ch.requests, contains('GET /tmpimage?path=%2Ftmp%2Fx.png'));
    expect(find.byType(MediaCard), findsOneWidget);
    expect(find.text('x.png'), findsOneWidget);
    r.dispose();
  });

  testWidgets('a project image shows a card from /file', (t) async {
    final r = await chat(t, [
      ...tool('Write', {'file_path': '/home/u/notes/img/a.png'}),
    ], (p, m, path) async => answer(200, png));
    expect(r.ch.requests, contains('GET /file?path=img%2Fa.png'));
    expect(find.byType(MediaCard), findsOneWidget);
    r.dispose();
  });

  testWidgets('a project video is a card that fetches nothing until tapped', (
    t,
  ) async {
    final r = await chat(t, [
      ...tool('Write', {'file_path': '/home/u/notes/v/clip.mp4'}),
    ], (p, m, path) async => answer(200, png));
    expect(find.text('clip.mp4'), findsOneWidget);
    expect(find.byIcon(Icons.play_arrow), findsOneWidget);
    expect(r.ch.requests.where((q) => q.contains('GET')), isEmpty);
    await t.tap(find.text('clip.mp4'));
    await t.pump();
    await t.pump(const Duration(milliseconds: 400));
    expect(find.byType(VideoScreen), findsOneWidget);
    r.dispose();
  });

  testWidgets('a missing file says it is gone, with no crash', (t) async {
    final r = await chat(t, [
      ...tool('Read', {'file_path': '/tmp/gone.png'}),
    ], (p, m, path) async => answer(404));
    expect(find.byType(MediaCard), findsOneWidget);
    expect(find.textContaining('not there'), findsOneWidget);
    expect(find.byType(Image), findsNothing);
    r.dispose();
  });

  for (final (what, input, req) in [
    (
      'tmp image',
      {'file_path': '/tmp/shot.png'},
      'GET /tmpimage?path=%2Ftmp%2Fshot.png',
    ),
    (
      'project image',
      {'file_path': '/home/u/notes/img/a.png'},
      'GET /file?path=img%2Fa.png',
    ),
  ]) {
    testWidgets('the same $what from two tool calls is read twice', (t) async {
      final r = await chat(t, [
        ...tool('Read', input, 't1'),
        ...tool('Read', input, 't2'),
      ], (p, m, path) async => answer(200, png));
      expect(find.byType(MediaCard), findsNWidgets(2));
      expect(r.ch.requests.where((q) => q == req), hasLength(2));
      r.dispose();
    });
  }

  testWidgets('a later call finding the file gone shows it gone', (t) async {
    var n = 0;
    final r = await chat(t, [
      ...tool('Read', {'file_path': '/tmp/shot.png'}, 't1'),
      ...tool('Read', {'file_path': '/tmp/shot.png'}, 't2'),
    ], (p, m, path) async => ++n == 1 ? answer(200, png) : answer(404));
    expect(find.byType(Image), findsOneWidget);
    expect(find.textContaining('not there'), findsOneWidget);
    r.dispose();
  });
}
