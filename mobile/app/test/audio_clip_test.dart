import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:nb_app/chat/audio_clip.dart';
import 'package:nb_app/chat/markdown.dart';
import 'package:nb_app/files/file_screen.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';
import 'support/voice_fakes.dart';

HttpAnswer answer(
  int status, [
  List<int> body = const [],
  Map<String, String> headers = const {},
]) => (status: status, headers: headers, body: Uint8List.fromList(body));

md.Element? firstElement(List<md.Node> nodes, String tag) {
  for (final n in nodes) {
    if (n is! md.Element) continue;
    if (n.tag == tag) return n;
    if (firstElement(n.children ?? const [], tag) case final e?) return e;
  }
  return null;
}

void main() {
  test(
    'a project sound embedded as an image parses as a clip; an image, a URL do not',
    () {
      final clip = firstElement(
        parseMarkdown('Listen: ![D](.shots/voice/clip_D.mp3)'),
        'nbaudio',
      );
      expect(clip?.attributes['src'], '.shots/voice/clip_D.mp3');
      expect(firstElement(parseMarkdown('![](a/b.png)'), 'nbaudio'), isNull);
      expect(firstElement(parseMarkdown('![](a/b.png)'), 'img'), isNotNull);
      expect(
        firstElement(parseMarkdown('![](https://x.org/a.mp3)'), 'nbaudio'),
        isNull,
      );
      for (final ext in ['wav', 'M4A', 'ogg']) {
        expect(
          firstElement(parseMarkdown('![](s.$ext)'), 'nbaudio'),
          isNotNull,
          reason: ext,
        );
      }
    },
  );

  test('a sound path resolves in its folder and never above the project', () {
    expect(soundFile('/r', 'a.mp3', base: 'docs'), 'docs/a.mp3');
    expect(soundFile('/r', './x/../a.mp3', base: 'docs/sub'), 'docs/sub/a.mp3');
    expect(soundFile('/r', '../../a.mp3', base: 'docs'), isNull);
    expect(soundFile('/r', '/r/s/a.mp3', base: 'docs'), 's/a.mp3');
    expect(soundFile('/r', '/elsewhere/a.mp3'), isNull);
  });

  group('in the feed', () {
    late Rig r;
    late Player native;
    late MemoryClipFiles clips;

    setUp(() {
      r = Rig();
      native = Player()..install();
      VoicePlayer.shared = VoicePlayer(files: MemoryVoiceFiles());
      clips = MemoryClipFiles();
      ClipFiles.shared = clips;
    });
    tearDown(() {
      native.uninstall();
      r.dispose();
    });

    Future<void> reply(
      WidgetTester t,
      String text,
      Future<HttpAnswer> Function(int, String, String) onHttp, {
      List<Map<String, Object?>> before = const [],
    }) async {
      await r.open(
        t,
        events: [
          ...before,
          agent({'t': 'message', 'id': 'm1', 'text': text}),
        ],
        settle: false,
      );
      r.ch.onHttp = onHttp;
      await t.pump();
    }

    Finder inClip(Finder f, [int at = 0]) =>
        find.descendant(of: find.byType(AudioClip).at(at), matching: f);

    testWidgets(
      'a reply\'s sound is a player row that fetches nothing until played',
      (t) async {
        await reply(
          t,
          'Take D:\n\n![](.shots/voice/clip_D.mp3)',
          (p, m, path) async => answer(200, [1, 2, 3]),
        );
        expect(find.byType(AudioClip), findsOneWidget);
        expect(inClip(find.text('clip_D.mp3')), findsOneWidget);
        expect(r.ch.requests.where((q) => q.contains('/file')), isEmpty);

        native.answer = (c) => c.method == 'play' ? 83000 : null;
        await t.tap(inClip(find.byTooltip('Play')));
        await t.pump();
        await t.pump();
        expect(
          r.ch.requests,
          contains('GET /file?path=.shots%2Fvoice%2Fclip_D.mp3'),
        );
        final play = native.calls.where((c) => c.method == 'play').single;
        expect((play.arguments as Map)['path'], startsWith('/cache/clips/'));
        expect((play.arguments as Map)['path'], endsWith('.mp3'));
        expect(clips.files.values.single, [1, 2, 3]);
        expect(inClip(find.byTooltip('Pause')), findsOneWidget);
        expect(inClip(find.text('0:00 / 1:23')), findsOneWidget);

        await native.call('position', {'ms': 5000});
        await t.pump();
        expect(inClip(find.text('0:05 / 1:23')), findsOneWidget);

        // a tap at the middle of the bar moves there
        await t.tap(inClip(find.byType(LinearProgressIndicator)));
        await t.pump();
        expect(native.calls.last.method, 'seek');
        expect(native.calls.last.arguments, {'ms': 41500});

        await t.tap(inClip(find.byTooltip('Pause')));
        await t.pump();
        expect(native.calls.last.method, 'pause');
      },
    );

    testWidgets(
      'an absolute path inside the project plays; a URL-encoded name is its file',
      (t) async {
        await reply(
          t,
          '![](/home/u/notes/a%20b/take%201.wav)',
          (p, m, path) async => answer(200, [1]),
        );
        expect(inClip(find.text('take 1.wav')), findsOneWidget);
        await t.tap(inClip(find.byTooltip('Play')));
        await t.pump();
        await t.pump();
        expect(r.ch.requests, contains('GET /file?path=a+b%2Ftake+1.wav'));
        expect(native.names, contains('play'));
      },
    );

    testWidgets(
      'one sound at a time: a clip stops a voice message, a second clip the first',
      (t) async {
        await reply(
          t,
          '![](a.mp3) and ![](b.ogg)',
          (p, m, path) async => answer(200, [1]),
          before: [
            {
              'kind': 'user',
              'id': 'u1',
              'text': 'hi',
              'voice': {
                'id': 'c' * 64,
                'ms': 12000,
                'wave': List.filled(48, 9),
              },
              'ts': 1,
              'historic': true,
            },
          ],
        );
        expect(find.byType(AudioClip), findsNWidgets(2));
        await VoicePlayer.shared.toggle(
          'c' * 64,
          () async => Uint8List.fromList([1]),
        );
        await t.pump();
        expect(native.names, ['play']);
        await t.tap(inClip(find.byTooltip('Play'), 0));
        await t.pump();
        await t.pump();
        expect(native.names, ['play', 'stop', 'play']);
        expect(VoicePlayer.shared.isCurrent('c' * 64), isFalse);
        await t.tap(inClip(find.byTooltip('Play'), 1));
        await t.pump();
        await t.pump();
        expect(native.names, ['play', 'stop', 'play', 'stop', 'play']);
        expect(inClip(find.byTooltip('Play'), 0), findsOneWidget);
        expect(inClip(find.byTooltip('Pause'), 1), findsOneWidget);
      },
    );

    testWidgets('a missing sound says so and plays nothing', (t) async {
      await reply(t, '![](gone.mp3)', (p, m, path) async => answer(404));
      await t.tap(inClip(find.byTooltip('Play')));
      await t.pump();
      await t.pump();
      expect(native.names, isNot(contains('play')));
      expect(find.text('This file is not there (any more).'), findsOneWidget);
    });

    testWidgets('a sound over the limit is not fetched past its length', (
      t,
    ) async {
      await reply(
        t,
        '![](big.mp3)',
        (p, m, path) async =>
            answer(200, [1], {'content-length': '${soundMaxBytes + 1}'}),
      );
      await t.tap(inClip(find.byTooltip('Play')));
      await t.pump();
      await t.pump();
      expect(native.names, isNot(contains('play')));
      expect(clips.files, isEmpty);
      expect(find.textContaining('too large'), findsOneWidget);
    });
    const unplayable =
        'The sound could not be played. Try again when the host is online.';

    testWidgets(
      'a clip left while it is fetched for another sound is not said to have failed',
      (t) async {
        final slow = Completer<HttpAnswer>();
        await reply(
          t,
          '![](a.mp3) and ![](b.ogg)',
          (p, m, path) => path.contains('a.mp3')
              ? slow.future
              : Future.value(answer(200, [1])),
        );
        await t.tap(inClip(find.byTooltip('Play'), 0));
        await t.pump();
        await t.tap(inClip(find.byTooltip('Play'), 1));
        await t.pump();
        await t.pump();
        slow.complete(answer(200, [1]));
        await t.pump();
        await t.pump();
        expect(find.text(unplayable), findsNothing);
        expect(inClip(find.byTooltip('Pause'), 1), findsOneWidget);
        expect(native.names.where((n) => n == 'play'), hasLength(1));
        // nothing of the left clip was kept
        expect(clips.files, hasLength(1));
      },
    );

    testWidgets('a clip left while its body comes stops reading it', (t) async {
      await reply(
        t,
        '![](a.mp3) and ![](b.ogg)',
        (p, m, path) async => answer(200, [1]),
      );
      final body = StreamController<Uint8List>();
      var cancels = 0;
      r.ch.onHttpStream = (port, method, path) async => path.contains('a.mp3')
          ? (
              status: 200,
              headers: const <String, String>{},
              body: body.stream,
              cancel: () {
                cancels++;
              },
            )
          : (
              status: 200,
              headers: const <String, String>{},
              body: Stream.value(Uint8List.fromList([1])),
              cancel: () {},
            );
      await t.tap(inClip(find.byTooltip('Play'), 0));
      await t.pump();
      body.add(Uint8List.fromList([1, 2]));
      await t.pump();
      expect(body.hasListener, isTrue);
      await t.tap(inClip(find.byTooltip('Play'), 1));
      await t.pump();
      await t.pump();
      expect(body.hasListener, isFalse);
      expect(cancels, 1);
      expect(find.text(unplayable), findsNothing);
      expect(inClip(find.byTooltip('Pause'), 1), findsOneWidget);
    });

    testWidgets('a body shorter than its length is not a sound', (t) async {
      await reply(
        t,
        '![](short.mp3)',
        (p, m, path) async => answer(200, [1, 2, 3], {'content-length': '10'}),
      );
      await t.tap(inClip(find.byTooltip('Play')));
      await t.pump();
      await t.pump();
      expect(native.names, isNot(contains('play')));
      expect(clips.files, isEmpty);
      expect(find.text(unplayable), findsOneWidget);
    });

    testWidgets(
      'in a Markdown file a sound plays, its path taken from the file\'s folder',
      (t) async {
        await r.open(t);
        r.ch.onHttp = (port, method, path) async => path.contains('.md')
            ? answer(200, '![](take.mp3)\n\n![](../sounds/x.wav)'.codeUnits)
            : answer(200, [1]);
        final nav = Navigator.of(t.element(find.byType(Scaffold).first));
        nav.push(
          MaterialPageRoute<void>(
            builder: (_) => FileScreen(tab: r.tab!, path: 'docs/plan.md'),
          ),
        );
        await t.pumpAndSettle();
        expect(find.byType(AudioClip), findsNWidgets(2));
        await t.tap(inClip(find.byTooltip('Play'), 0));
        await t.pump();
        await t.pump();
        expect(r.ch.requests, contains('GET /file?path=docs%2Ftake.mp3'));
        await t.tap(inClip(find.byTooltip('Play'), 1));
        await t.pump();
        await t.pump();
        expect(r.ch.requests, contains('GET /file?path=sounds%2Fx.wav'));
        expect(native.names, ['play', 'stop', 'play']);
      },
    );
  });
}
