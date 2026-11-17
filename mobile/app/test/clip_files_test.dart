import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/audio_clip.dart';
import 'package:nb_app/media/fetch.dart';

import 'support/voice_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory dir;
  late Player native;
  final files = DiskClipFiles();

  setUp(() {
    dir = Directory.systemTemp.createTempSync('nb-clips-');
    native = Player()..answer = ((c) => c.method == 'dir' ? dir.path : null);
    native.install();
  });
  tearDown(() {
    native.uninstall();
    dir.deleteSync(recursive: true);
  });

  List<String> left() => [
    for (final f in Directory('${dir.path}/clips').listSync())
      f.uri.pathSegments.last,
  ];

  test('a sound is written whole under its name, nothing aside left', () async {
    final got = await files.write(
      'a.mp3',
      Stream.fromIterable([
        [1, 2],
        [3],
      ]),
      max: 10,
      length: 3,
    );
    expect(got.fail, isNull);
    expect(File(got.path!).readAsBytesSync(), [1, 2, 3]);
    expect(left(), ['a.mp3']);
  });

  test(
    'two reads of one sound at once do not share their file aside',
    () async {
      final one = StreamController<List<int>>(),
          two = StreamController<List<int>>();
      final a = files.write('s.mp3', one.stream, max: 100);
      final b = files.write('s.mp3', two.stream, max: 100);
      for (var i = 0; i < 5; i++) {
        one.add([1, 1]);
        two.add([2, 2]);
        await Future<void>.delayed(Duration.zero);
      }
      await one.close();
      final first = await a;
      expect(File(first.path!).readAsBytesSync(), List.filled(10, 1));
      await two.close();
      final second = await b;
      expect(second.path, first.path);
      expect(File(second.path!).readAsBytesSync(), List.filled(10, 2));
      expect(left(), ['s.mp3']);
    },
  );

  test('a body that breaks off leaves nothing', () async {
    final body = StreamController<List<int>>();
    final w = files.write('e.mp3', body.stream, max: 100);
    body.add([1]);
    body.addError(const SocketException('gone'));
    expect((await w).fail, FetchFail.unreadable);
    expect(left(), isEmpty);
  });

  test('a body shorter than its length leaves nothing', () async {
    final got = await files.write(
      's.mp3',
      Stream.value([1, 2, 3]),
      max: 100,
      length: 10,
    );
    expect(got, (path: null, fail: FetchFail.unreadable));
    expect(left(), isEmpty);
  });

  test('a body past the limit stops being read and leaves nothing', () async {
    final body = StreamController<List<int>>();
    final w = files.write('b.mp3', body.stream, max: 3);
    body.add([1, 2]);
    body.add([3, 4]);
    expect((await w).fail, FetchFail.tooLarge);
    expect(body.hasListener, isFalse);
    expect(left(), isEmpty);
  });

  test('a read left for another sound stops and leaves nothing', () async {
    final body = StreamController<List<int>>();
    final abandon = Completer<void>();
    final w = files.write(
      'l.mp3',
      body.stream,
      max: 100,
      abandoned: abandon.future,
    );
    body.add([1]);
    await Future<void>.delayed(Duration.zero);
    abandon.complete();
    expect((await w).path, isNull);
    expect(body.hasListener, isFalse);
    expect(left(), isEmpty);
  });
}
