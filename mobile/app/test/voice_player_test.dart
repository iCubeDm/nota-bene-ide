import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_app/voice/recorder.dart';

import 'support/voice_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Player native;
  late MemoryVoiceFiles files;
  late VoicePlayer p;
  var fetched = 0;
  Future<Uint8List?> load() async {
    fetched++;
    return Uint8List.fromList([1, 2, 3]);
  }

  setUp(() {
    native = Player()..install();
    files = MemoryVoiceFiles();
    p = VoicePlayer(files: files);
    fetched = 0;
  });
  tearDown(() => native.uninstall());

  test('play fetches once, caches the file and plays its path', () async {
    await p.toggle('a', load);
    expect(fetched, 1);
    expect(files.saved, ['a']);
    expect(native.calls.single.method, 'play');
    expect(native.calls.single.arguments, {
      'path': '/cache/voice/a.wav',
      'from': 0,
    });
    expect((p.id, p.playing), ('a', true));
    // played to its end, and again: the cached file is used
    await native.call('done');
    expect(p.id, isNull);
    await p.toggle('a', load);
    expect(fetched, 1);
  });

  test('a second voice stops the first', () async {
    await p.toggle('a', load);
    await p.toggle('b', load);
    expect(native.names, ['play', 'stop', 'play']);
    expect(p.id, 'b');
    expect(p.isCurrent('a'), isFalse);
  });

  test('toggle pauses and resumes from where it was', () async {
    await p.toggle('a', load);
    await native.call('position', {'ms': 1200});
    expect(p.position, const Duration(milliseconds: 1200));
    await p.toggle('a', load);
    expect((p.playing, native.calls.last.method), (false, 'pause'));
    await p.toggle('a', load);
    expect(native.calls.last.arguments, {
      'path': '/cache/voice/a.wav',
      'from': 1200,
    });
    expect(p.playing, isTrue);
  });

  test('seek moves a playing voice, and starts a silent one there', () async {
    await p.seek('a', load, const Duration(seconds: 2));
    expect(native.calls.last.arguments, {
      'path': '/cache/voice/a.wav',
      'from': 2000,
    });
    await p.seek('a', load, const Duration(seconds: 5));
    expect(native.calls.last.method, 'seek');
    expect(native.calls.last.arguments, {'ms': 5000});
  });

  test('a voice that cannot be fetched is not playing', () async {
    await p.toggle('a', () async => null);
    expect((p.id, p.playing, p.loading), (null, false, false));
    expect(native.calls, isEmpty);
  });

  test('stop silences and forgets', () async {
    await p.toggle('a', load);
    await p.stop();
    expect(native.calls.last.method, 'stop');
    expect(p.id, isNull);
  });

  test(
    'dragging over an uncached voice downloads it once and plays from the last position',
    () async {
      final gate = Completer<Uint8List?>();
      var loads = 0;
      Future<Uint8List?> slow() {
        loads++;
        return gate.future;
      }

      final first = p.seek('a', slow, const Duration(seconds: 1));
      await p.seek('a', slow, const Duration(seconds: 2));
      await p.seek('a', slow, const Duration(seconds: 3));
      expect(p.position, const Duration(seconds: 3));
      gate.complete(Uint8List.fromList([1]));
      await first;
      expect(loads, 1);
      expect(native.names, ['play']);
      expect((native.calls.single.arguments as Map)['from'], 3000);
    },
  );

  test('a voice does not play while the microphone is recording', () async {
    Microphone.hot.value = true;
    addTearDown(() => Microphone.hot.value = false);
    await p.toggle('a', load);
    expect(native.calls, isEmpty);
    expect(p.id, isNull);
  });

  test(
    'a sound plays from the file it opens each start, and keeps its length',
    () async {
      var opened = 0;
      Future<String?> open(Future<void> abandoned) async {
        opened++;
        return '/cache/clips/x.mp3';
      }

      native.answer = (c) => c.method == 'play' ? 61000 : null;
      expect(p.lengthOf('s'), isNull);
      await p.toggleSound('s', open);
      expect(native.calls.single.arguments, {
        'path': '/cache/clips/x.mp3',
        'from': 0,
        'music': true,
      });
      expect(files.saved, isEmpty);
      expect(p.lengthOf('s'), const Duration(seconds: 61));
      // paused and resumed: the same file; played to its end and again: opened again (it may have changed)
      await p.toggleSound('s', open);
      await p.toggleSound('s', open);
      expect(opened, 1);
      await native.call('done');
      await p.toggleSound('s', open);
      expect(opened, 2);
      expect(p.lengthOf('s'), const Duration(seconds: 61));
    },
  );

  test('a sound with no file is not playing', () async {
    await p.toggleSound('s', (_) async => null);
    expect(native.calls, isEmpty);
    expect(p.id, isNull);
  });

  test('a sound left while it opens is told so and reported as left', () async {
    final gate = Completer<String?>();
    var left = false;
    final a = p.toggleSound('a', (abandoned) {
      abandoned.then((_) => left = true);
      return gate.future;
    });
    final b = await p.toggleSound('b', (_) async => '/cache/clips/b.mp3');
    await Future<void>.delayed(Duration.zero);
    expect(left, isTrue);
    gate.complete('/cache/clips/a.mp3');
    expect(await a, SoundStart.left);
    expect(b, SoundStart.playing);
    expect(native.names, ['stop', 'play']);
    expect(p.isCurrent('b'), isTrue);
  });

  test('a start says why a sound does not play', () async {
    expect(await p.toggleSound('a', (_) async => null), SoundStart.noFile);
    native.answer = (c) =>
        c.method == 'play' ? throw PlatformException(code: 'failed') : null;
    expect(
      await p.toggleSound('a', (_) async => '/cache/clips/a.ogg'),
      SoundStart.unplayable,
    );
    expect(p.id, isNull);
  });

  test('a clip plays as music, a voice as speech', () async {
    await p.toggleSound('s', (_) async => '/cache/clips/s.mp3');
    expect((native.calls.last.arguments as Map)['music'], isTrue);
    await p.toggle('v', load);
    expect((native.calls.last.arguments as Map).containsKey('music'), isFalse);
  });
}
