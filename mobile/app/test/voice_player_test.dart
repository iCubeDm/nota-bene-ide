import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/voice/player.dart';

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
}
