import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:nb_app/files/video_screen.dart';
import 'package:nb_app/media/frame.dart';
import 'package:nb_app/media/proxy.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:video_player_platform_interface/video_player_platform_interface.dart';

import 'support/rig.dart';

final framePng = Uint8List.fromList(
  img.encodePng(
    img.Image(width: 72, height: 128)..clear(img.ColorRgb8(30, 120, 200)),
  ),
);
final attachId = 'a' * 64;

HttpAnswer bytes(int status, List<int> b, [Map<String, String> h = const {}]) =>
    (status: status, headers: h, body: Uint8List.fromList(b));

/// Lets the real socket, image decoding and rendering run, then settles the frames.
Future<void> settleReal(WidgetTester t, [int rounds = 6]) async {
  for (var i = 0; i < rounds; i++) {
    await t.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await t.pump();
  }
  await t.pumpAndSettle();
}

/// A player that plays nothing: it records what it was asked and reports a 72x128, two minute video.
class FakePlayer extends VideoPlayerPlatform with MockPlatformInterfaceMixin {
  final sources = <String?>[];
  final calls = <String>[];
  var failInit = false;
  var _at = Duration.zero;
  final _events = StreamController<VideoEvent>();

  @override
  Future<void> init() async {}

  @override
  Future<int?> create(DataSource dataSource) async {
    sources.add(dataSource.uri);
    return 7;
  }

  @override
  Future<int?> createWithOptions(VideoCreationOptions options) =>
      create(options.dataSource);

  @override
  Stream<VideoEvent> videoEventsFor(int playerId) {
    scheduleMicrotask(() {
      if (failInit) {
        _events.addError(PlatformException(code: 'video', message: 'broken'));
      } else {
        _events.add(
          VideoEvent(
            eventType: VideoEventType.initialized,
            size: const Size(72, 128),
            duration: const Duration(minutes: 2),
          ),
        );
      }
    });
    return _events.stream;
  }

  @override
  Future<void> play(int playerId) async => calls.add('play');

  @override
  Future<void> pause(int playerId) async => calls.add('pause');

  @override
  Future<void> seekTo(int playerId, Duration position) async {
    calls.add('seekTo ${position.inMilliseconds}');
    _at = position;
  }

  @override
  Future<Duration> getPosition(int playerId) async => _at;

  @override
  Future<void> setVolume(int playerId, double volume) async {}

  @override
  Future<void> setLooping(int playerId, bool looping) async {}

  @override
  Future<void> setPlaybackSpeed(int playerId, double speed) async {}

  @override
  Future<void> dispose(int playerId) async => calls.add('dispose');

  @override
  Widget buildView(int playerId) => const SizedBox();
}

Map<String, Object?> mediaComment(String id, double time) => {
  'id': id,
  'anchor': {
    'kind': 'media',
    'source': {'kind': 'file', 'path': 'v/demo.mp4'},
    'width': 72,
    'height': 128,
    'time': time,
    'shapes': [
      {'kind': 'arrow', 'color': '#ffffff', 'x1': 0, 'y1': 0, 'x2': 1, 'y2': 1},
    ],
  },
  'text': 't',
  'status': 'pending',
  'createdAt': 1,
  'images': [attachId],
  'genImages': 1,
};

late FakePlayer player;
MediaProxy? proxy;
var frameCalls = <Map<Object?, Object?>>[];
var frameFails = false;

Future<Rig> openVideo(
  WidgetTester t, {
  double? at,
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
    if (p == '/attach') {
      return bytes(
        200,
        utf8.encode(jsonEncode({'id': attachId, 'mediaType': 'image/png'})),
      );
    }
    return bytes(200, utf8.encode('{}'));
  };
  r.event({'kind': 'comments', 'items': comments});
  await t.pumpAndSettle();
  Navigator.of(t.element(find.byType(Scaffold).first)).push(
    MaterialPageRoute<void>(
      builder: (_) => VideoScreen(
        tab: r.tab!,
        path: 'v/demo.mp4',
        at: at,
        // the file is never read: the fake player does not fetch
        startProxy: (_) async => proxy = await MediaProxy.start(
          (m, h) async => throw StateError('unused'),
        ),
      ),
    ),
  );
  await settleReal(t, 4);
  return r;
}

void main() {
  setUp(() {
    player = FakePlayer();
    VideoPlayerPlatform.instance = player;
    proxy = null;
    frameCalls = [];
    frameFails = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(frameChannel, (call) async {
          frameCalls.add(Map<Object?, Object?>.from(call.arguments as Map));
          if (frameFails) throw PlatformException(code: 'frame');
          return {'png': framePng, 'width': 72, 'height': 128};
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(frameChannel, null);
  });

  testWidgets('the player is created with the proxy\'s address', (t) async {
    final r = await openVideo(t);
    expect(player.sources, ['${proxy!.uri}']);
    expect(
      RegExp(r'^http://127\.0\.0\.1:\d+/[\w-]+$').hasMatch(player.sources[0]!),
      isTrue,
    );
    r.dispose();
  });

  testWidgets(
    'a paused frame marked up becomes a media comment with its time',
    (t) async {
      final r = await openVideo(t, at: 61.5);
      expect(player.calls, contains('seekTo 61500'));
      expect(player.calls, isNot(contains('play')));
      await t.tap(find.byTooltip('Mark up'));
      await settleReal(t, 4);
      expect(frameCalls.single['us'], 61500000);
      expect(frameCalls.single['url'], '${proxy!.uri}');
      final box = t.getRect(find.byKey(const ValueKey('markup-surface')));
      await t.tap(find.byTooltip('Arrow'));
      await t.pumpAndSettle();
      await t.dragFrom(
        box.topLeft + Offset(box.width / 4, box.height / 4),
        Offset(box.width / 2, box.height / 2),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Comment'));
      await t.pumpAndSettle();
      await t.enterText(find.byType(TextField), 'here');
      await t.tap(find.text('Save'));
      await settleReal(t, 10);
      final paths = r.ch.calls.map((c) => '${c.method} ${c.path}').toList();
      final id = r.ch.calls
          .firstWhere((c) => c.path.endsWith('/frame.jpg'))
          .path
          .split('/')[2];
      expect(
        paths,
        containsAllInOrder([
          'POST /marks/$id/frame.jpg',
          'POST /marks/$id/layer.png',
          'POST /attach',
        ]),
      );
      final sets = [
        for (final m in r.sent)
          if (m['type'] == 'comments') m,
      ];
      final a = ((sets.last['items'] as List).single as Map)['anchor'] as Map;
      expect(a['kind'], 'media');
      expect(a['time'], 61.5);
      expect((a['width'], a['height']), (72, 128));
      expect(a['source'], {'kind': 'file', 'path': 'v/demo.mp4'});
      expect((a['shapes'] as List).single['kind'], 'arrow');
      expect(find.byTooltip('Mark up'), findsOneWidget, reason: 'marking ends');
      r.dispose();
    },
  );

  testWidgets('a frame that could not be taken says so and marks nothing', (
    t,
  ) async {
    frameFails = true;
    final r = await openVideo(t, at: 3);
    await t.tap(find.byTooltip('Mark up'));
    await settleReal(t, 4);
    expect(find.textContaining('could not be taken'), findsOneWidget);
    expect(find.text('Comment'), findsNothing);
    expect(find.byTooltip('Undo'), findsNothing, reason: 'no toolbar');
    expect([
      for (final m in r.sent)
        if (m['type'] == 'comments') m,
    ], isEmpty);
    r.dispose();
  });

  testWidgets('a comment\'s tick seeks to its time and pauses', (t) async {
    final r = await openVideo(t, comments: [mediaComment('c1', 42.25)]);
    player.calls.clear();
    await t.tap(find.byKey(const ValueKey('tick-c1')));
    await settleReal(t, 2);
    expect(player.calls, containsAll(['seekTo 42250', 'pause']));
    expect(find.text('0:42.250'), findsOneWidget);
    r.dispose();
  });

  testWidgets('leaving the screen disposes the player and the proxy', (
    t,
  ) async {
    final r = await openVideo(t);
    expect(proxy!.isClosed, isFalse);
    Navigator.of(t.element(find.byType(VideoScreen))).pop();
    await settleReal(t, 3);
    // the player's dispose waits on its own real futures
    await t.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 200)),
    );
    expect(player.calls, contains('dispose'));
    expect(proxy!.isClosed, isTrue);
    r.dispose();
  });

  testWidgets('a video that will not initialize shows its state', (t) async {
    player.failInit = true;
    final r = await openVideo(t);
    expect(find.textContaining('could not be played'), findsOneWidget);
    expect(find.byTooltip('Mark up'), findsNothing);
    r.dispose();
  });
}
