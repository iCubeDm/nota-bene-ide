// A project image or video embedded in a reply (issue 459): a preview in the feed and in a Markdown file opened full
// screen, a tap opening the phone's own viewer.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:markdown/markdown.dart' as md;
import 'package:nb_app/chat/embed.dart';
import 'package:nb_app/chat/markdown.dart';
import 'package:nb_app/files/file_screen.dart';
import 'package:nb_app/files/image_screen.dart';
import 'package:nb_app/files/video_screen.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';

final png = Uint8List.fromList(
  img.encodePng(
    img.Image(width: 200, height: 100)..clear(img.ColorRgb8(200, 30, 30)),
  ),
);

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

Future<void> settleReal(WidgetTester t, [int rounds = 4]) async {
  for (var i = 0; i < rounds; i++) {
    await t.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 60)),
    );
    await t.pump();
  }
}

/// A chat whose host answers [onHttp], with an agent reply of [text].
Future<Rig> reply(
  WidgetTester t,
  String text,
  Future<HttpAnswer> Function(int, String, String) onHttp,
) async {
  final r = Rig();
  await r.open(t);
  r.ch.onHttp = onHttp;
  r.event({
    'kind': 'replay',
    'events': [
      agent({'t': 'message', 'id': 'm1', 'text': text}),
    ],
  });
  await t.pumpAndSettle();
  await settleReal(t);
  return r;
}

void main() {
  test(
    'a project image or video embedded as an image parses as an embed; a URL stays an image',
    () {
      final image = firstElement(
        parseMarkdown('See ![shot](design/shot.png)'),
        'nbimage',
      );
      expect(image?.attributes['src'], 'design/shot.png');
      final video = firstElement(
        parseMarkdown('![](media/clip.mp4)'),
        'nbvideo',
      );
      expect(video?.attributes['src'], 'media/clip.mp4');
      for (final ext in ['JPG', 'jpeg', 'gif', 'webp']) {
        expect(
          firstElement(parseMarkdown('![](a.$ext)'), 'nbimage'),
          isNotNull,
          reason: ext,
        );
      }
      for (final ext in ['mov', 'WEBM', 'm4v']) {
        expect(
          firstElement(parseMarkdown('![](a.$ext)'), 'nbvideo'),
          isNotNull,
          reason: ext,
        );
      }
      final web = parseMarkdown('![](https://x.org/a.png)');
      expect(firstElement(web, 'nbimage'), isNull);
      expect(
        firstElement(web, 'img')?.attributes['src'],
        'https://x.org/a.png',
      );
      expect(
        firstElement(parseMarkdown('![](https://x.org/a.mp4)'), 'nbvideo'),
        isNull,
      );
      // a sound stays a sound, anything else an image
      expect(firstElement(parseMarkdown('![](a.mp3)'), 'nbaudio'), isNotNull);
      expect(firstElement(parseMarkdown('![](a.svg)'), 'img'), isNotNull);
    },
  );

  test('an embed path resolves in its folder and never above the project', () {
    expect(embedFile('/r', 'a.png', base: 'docs'), 'docs/a.png');
    expect(embedFile('/r', './x/../a.png', base: 'docs/sub'), 'docs/sub/a.png');
    expect(embedFile('/r', '../../a.png', base: 'docs'), isNull);
    expect(embedFile('/r', '/r/s/a.mp4', base: 'docs'), 's/a.mp4');
    expect(embedFile('/r', '/elsewhere/a.png'), isNull);
  });

  testWidgets(
    'a reply\'s project image is a preview from /file; a tap opens the viewer on it, back returns',
    (t) async {
      final r = await reply(
        t,
        'The new look:\n\n![shot](design/shot.png)',
        (p, m, path) async => answer(200, png),
      );
      expect(r.ch.requests, contains('GET /file?path=design%2Fshot.png'));
      expect(find.byType(EmbeddedMedia), findsOneWidget);
      final shown = find.descendant(
        of: find.byType(EmbeddedMedia),
        matching: find.byType(Image),
      );
      expect(shown, findsOneWidget);
      // the aspect is kept within the bounded height
      final box = t.getSize(shown);
      expect(box.height, lessThanOrEqualTo(embedMaxHeight));
      expect(box.width / box.height, closeTo(2, 0.05));

      await t.tap(shown);
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      final viewer = t.widget<ImageScreen>(find.byType(ImageScreen));
      expect(viewer.items.single.path, 'design/shot.png');

      Navigator.of(t.element(find.byType(ImageScreen))).pop();
      await t.pump();
      await t.pump(const Duration(seconds: 1));
      expect(find.byType(ImageScreen), findsNothing);
      expect(find.byType(EmbeddedMedia), findsOneWidget);
      r.dispose();
    },
  );

  testWidgets(
    'a reply\'s project video is a tile with its name and a play mark; a tap opens the video screen',
    (t) async {
      final r = await reply(
        t,
        '![](media/clip.mp4)',
        (p, m, path) async => answer(206, [0]),
      );
      expect(find.byType(EmbeddedMedia), findsOneWidget);
      expect(find.text('clip.mp4'), findsOneWidget);
      expect(find.byIcon(Icons.play_arrow), findsOneWidget);
      // only asked whether it is there: one byte
      final ask = r.ch.calls.singleWhere((c) => c.path.startsWith('/file'));
      expect(ask.path, '/file?path=media%2Fclip.mp4');
      expect(ask.headers['range'], 'bytes=0-0');

      await t.tap(find.text('clip.mp4'));
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(
        t.widget<VideoScreen>(find.byType(VideoScreen)).path,
        'media/clip.mp4',
      );
      r.dispose();
    },
  );

  testWidgets(
    'in a Markdown file images and videos resolve from the file\'s folder',
    (t) async {
      final r = Rig();
      await r.open(t);
      r.ch.onHttp = (port, method, path) async => path.contains('.md')
          ? answer(200, '![](shot.png)\n\n![](../media/c.mp4)'.codeUnits)
          : path.contains('.png')
          ? answer(200, png)
          : answer(206, [0]);
      Navigator.of(t.element(find.byType(Scaffold).first)).push(
        MaterialPageRoute<void>(
          builder: (_) => FileScreen(tab: r.tab!, path: 'docs/plan.md'),
        ),
      );
      await t.pumpAndSettle();
      await settleReal(t);
      expect(find.byType(EmbeddedMedia), findsNWidgets(2));
      expect(r.ch.requests, contains('GET /file?path=docs%2Fshot.png'));
      expect(r.ch.requests, contains('GET /file?path=media%2Fc.mp4'));

      await t.tap(
        find.descendant(
          of: find.byType(EmbeddedMedia).first,
          matching: find.byType(Image),
        ),
      );
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(
        t.widget<ImageScreen>(find.byType(ImageScreen)).items.single.path,
        'docs/shot.png',
      );
      Navigator.of(t.element(find.byType(ImageScreen))).pop();
      await t.pump();
      await t.pump(const Duration(seconds: 1));

      await t.tap(find.text('c.mp4'));
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(
        t.widget<VideoScreen>(find.byType(VideoScreen)).path,
        'media/c.mp4',
      );
      r.dispose();
    },
  );

  group('a file that does not show says so in a row', () {
    for (final (what, text, onHttp, says) in [
      (
        'a missing image',
        '![](gone.png)',
        (int p, String m, String path) async => answer(404),
        'This file is not there (any more).',
      ),
      (
        'an image outside the project',
        '![](/elsewhere/a.png)',
        (int p, String m, String path) async => answer(200, png),
        'This file is outside the project.',
      ),
      (
        'an image the window refuses',
        '![](secret.png)',
        (int p, String m, String path) async => answer(403),
        'This file is outside the project.',
      ),
      (
        'an image over the limit',
        '![](big.png)',
        (int p, String m, String path) async =>
            answer(200, [1], {'content-length': '${imageMaxBytes + 1}'}),
        'The image is too large for the phone (over 32 MB). Open it on the computer.',
      ),
      (
        'an image that is no picture',
        '![](broken.png)',
        (int p, String m, String path) async => answer(200, [1, 2, 3]),
        'The image could not be shown.',
      ),
      (
        'an unreadable image',
        '![](x.png)',
        (int p, String m, String path) async => answer(500),
        'The file could not be read. Try again when the host is online.',
      ),
      (
        'a missing video',
        '![](gone.mp4)',
        (int p, String m, String path) async => answer(404),
        'This file is not there (any more).',
      ),
      (
        'a video outside the project',
        '![](../up.mp4)',
        (int p, String m, String path) async => answer(206, [0]),
        'This file is outside the project.',
      ),
    ]) {
      testWidgets(what, (t) async {
        final r = await reply(t, text, onHttp);
        expect(find.byType(EmbeddedMedia), findsOneWidget);
        expect(find.text(says), findsOneWidget);
        final name = RegExp(r'([^/(]+)\)$').firstMatch(text)![1]!;
        expect(
          find.descendant(
            of: find.byType(EmbeddedMedia),
            matching: find.text(name),
          ),
          findsOneWidget,
        );
        if (says.contains('outside') && !text.contains('secret')) {
          expect(r.ch.requests.where((q) => q.contains('/file')), isEmpty);
        }
        // nothing to open
        await t.tap(find.byType(EmbeddedMedia), warnIfMissed: false);
        await t.pumpAndSettle();
        expect(find.byType(ImageScreen), findsNothing);
        expect(find.byType(VideoScreen), findsNothing);
        r.dispose();
      });
    }
  });
}
