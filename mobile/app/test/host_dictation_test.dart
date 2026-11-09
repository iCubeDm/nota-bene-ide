import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/dictation/dictation.dart';
import 'package:nb_app/dictation/host_dictation.dart';
import 'package:nb_app/media/media_comment.dart';
import 'package:nb_channel/nb_channel.dart';

/// The phone's recorder (`nb/record`), played by the test.
class Recorder {
  final calls = <String>[];
  Object? startError;
  var wav = Uint8List.fromList([82, 73, 70, 70, 1, 2, 3]);
  bool stopNull = false;

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(recordChannel, (call) async {
          calls.add(call.method);
          if (call.method == 'start' && startError != null) {
            throw PlatformException(code: startError! as String);
          }
          return call.method == 'stop' && !stopNull ? wav : null;
        });
  }

  void uninstall() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .setMockMethodCallHandler(recordChannel, null);

  /// The recorder stopping itself at its cap.
  Future<void> cap() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .handlePlatformMessage(
        recordChannel.name,
        recordChannel.codec.encodeMethodCall(const MethodCall('capped')),
        (_) {},
      );

  /// The recorder reporting its input level.
  Future<void> level(double v) => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .handlePlatformMessage(
        recordChannel.name,
        recordChannel.codec.encodeMethodCall(MethodCall('level', v)),
        (_) {},
      );

  /// The recorder failing under the phone (a read error).
  Future<void> fail() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .handlePlatformMessage(
        recordChannel.name,
        recordChannel.codec.encodeMethodCall(const MethodCall('failed')),
        (_) {},
      );
}

HttpAnswer answer(int status, [String body = '{}']) =>
    (status: status, headers: const {}, body: utf8.encode(body));

Future<void> tick() => Future<void>.delayed(Duration.zero);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Recorder rec;
  setUp(() => rec = Recorder()..install());
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(recordChannel, null),
  );

  test(
    'level calls become DictationLevel while recording, none after stop',
    () async {
      final d = HostDictation(
        () =>
            (m, p, {headers, body}) async => answer(200, '{"text":"hi"}'),
      );
      final events = <DictationEvent>[];
      final sub = d.listen('en').listen(events.add);
      await tick();

      await rec.level(0.5);
      await tick();
      expect(events.whereType<DictationLevel>().map((e) => e.value), [0.5]);

      await d.stop();
      await tick();
      await rec.level(0.9);
      await tick();
      expect(events.whereType<DictationLevel>(), hasLength(1));
      await sub.cancel();
    },
  );

  test('stop posts the recording as audio/wav in the UI language', () async {
    String? method, path;
    Map<String, String>? sentHeaders;
    List<int>? sentBody;
    final d = HostDictation(
      () => (m, p, {headers, body}) async {
        method = m;
        path = p;
        sentHeaders = headers;
        sentBody = body;
        return answer(200, '{"text":"fix the header"}');
      },
    );
    final events = <DictationEvent>[];
    d.listen('ru').listen(events.add);
    await tick();
    await d.stop();
    await tick();
    expect((method, path), ('POST', '/dictation/transcribe?lang=ru'));
    expect(sentHeaders!['content-type'], 'audio/wav');
    expect(sentBody, rec.wav);
    expect(events.map((e) => e.runtimeType), [
      DictationWorking,
      DictationFinal,
      DictationEnd,
    ]);
    expect((events[1] as DictationFinal).text, 'fix the header');
  });

  test('500, offline and a dead connection are hostFailed', () async {
    for (final h in <WindowHttp? Function()>[
      () =>
          (m, p, {headers, body}) async => answer(500),
      () => null,
      () =>
          (m, p, {headers, body}) async => throw StreamClosed(1000),
    ]) {
      final d = HostDictation(h);
      final events = <DictationEvent>[];
      d.listen('en').listen(events.add);
      await tick();
      await d.stop();
      await tick();
      expect(
        events.whereType<DictationError>().single.why,
        DictationFailure.hostFailed,
      );
      expect(events.last, isA<DictationEnd>());
    }
  });

  test(
    'a 503 is hostOff and tells the tab; other statuses are hostFailed',
    () async {
      for (final (status, why, off) in [
        (503, DictationFailure.hostOff, 1),
        (500, DictationFailure.hostFailed, 0),
      ]) {
        var offs = 0;
        final d = HostDictation(
          () =>
              (m, p, {headers, body}) async => answer(status),
          onHostOff: () => offs++,
        );
        final events = <DictationEvent>[];
        d.listen('en').listen(events.add);
        await tick();
        await d.stop();
        await tick();
        expect(events.whereType<DictationError>().single.why, why);
        expect(offs, off);
      }
    },
  );

  testWidgets('a post that never answers is hostFailed after 60 s', (t) async {
    final d = HostDictation(
      () =>
          (m, p, {headers, body}) => Completer<HttpAnswer>().future,
    );
    final events = <DictationEvent>[];
    d.listen('en').listen(events.add);
    await t.pump();
    unawaited(d.stop());
    await t.pump();
    await t.pump(const Duration(seconds: 59));
    expect(events.whereType<DictationError>(), isEmpty);
    await t.pump(const Duration(seconds: 2));
    expect(
      events.whereType<DictationError>().single.why,
      DictationFailure.hostFailed,
    );
    expect(events.last, isA<DictationEnd>());
  });

  testWidgets('a long recording is given time to transcribe', (t) async {
    // 55 s of 16 kHz 16-bit mono after the 44-byte header: one part
    rec.wav = Uint8List(44 + 55 * 32000);
    final reply = Completer<HttpAnswer>();
    final d = HostDictation(
      () =>
          (m, p, {headers, body}) => reply.future,
    );
    final events = <DictationEvent>[];
    d.listen('en').listen(events.add);
    await t.pump();
    unawaited(d.stop());
    await t.pump();
    await t.pump(const Duration(seconds: 150));
    expect(events.whereType<DictationError>(), isEmpty);
    reply.complete(answer(200, '{"text":"long"}'));
    await t.pump();
    expect(events.whereType<DictationFinal>().single.text, 'long');
  });

  test(
    'no audio from the recorder: hostFailed, and the recorder is cancelled',
    () async {
      rec.stopNull = true;
      final d = HostDictation(
        () =>
            (m, p, {headers, body}) async => answer(200, '{"text":"x"}'),
      );
      final events = <DictationEvent>[];
      d.listen('en').listen(events.add);
      await tick();
      await d.stop();
      await tick();
      expect(
        events.whereType<DictationError>().single.why,
        DictationFailure.hostFailed,
      );
      expect(rec.calls, ['start', 'stop', 'cancel']);
    },
  );

  test(
    'a recorder failure is reported as failed and ends the session',
    () async {
      var posts = 0;
      final d = HostDictation(
        () => (m, p, {headers, body}) async {
          posts++;
          return answer(200);
        },
      );
      final events = <DictationEvent>[];
      d.listen('en').listen(events.add);
      await tick();
      await rec.fail();
      await tick();
      expect(
        events.whereType<DictationError>().single.why,
        DictationFailure.failed,
      );
      expect(events.last, isA<DictationEnd>());
      expect(posts, 0);
      await d.stop();
      expect(rec.calls, contains('cancel'));
    },
  );

  test('a denied microphone is denied; a stop after it is ignored', () async {
    rec.startError = 'denied';
    final d = HostDictation(
      () =>
          (m, p, {headers, body}) async => answer(200),
    );
    final events = <DictationEvent>[];
    d.listen('en').listen(events.add);
    await tick();
    expect(
      events.whereType<DictationError>().single.why,
      DictationFailure.denied,
    );
    await d.stop();
    expect(rec.calls, ['start']);
  });

  test('the recorder reaching its cap acts like stop', () async {
    var posts = 0;
    final d = HostDictation(
      () => (m, p, {headers, body}) async {
        posts++;
        return answer(200, '{"text":"hi"}');
      },
    );
    final events = <DictationEvent>[];
    d.listen('en').listen(events.add);
    await tick();
    await rec.cap();
    await tick();
    expect(posts, 1);
    expect(events.last, isA<DictationEnd>());
  });

  test('cancel ends without a post', () async {
    var posts = 0;
    final d = HostDictation(
      () => (m, p, {headers, body}) async {
        posts++;
        return answer(200);
      },
    );
    d.listen('en').listen((_) {});
    await tick();
    await d.cancel();
    await d.stop();
    expect(posts, 0);
    expect(rec.calls, ['start', 'cancel']);
  });

  group('a long recording', () {
    // 100 s of silence: two parts
    setUp(() => rec.wav = Uint8List(44 + 100 * 32000));

    test(
      'goes in parts, one after another, and the texts are joined',
      () async {
        final replies = <Completer<HttpAnswer>>[];
        final sizes = <int>[];
        final d = HostDictation(
          () => (m, p, {headers, body}) {
            sizes.add(body!.length);
            replies.add(Completer<HttpAnswer>());
            return replies.last.future;
          },
        );
        final events = <DictationEvent>[];
        d.listen('en').listen(events.add);
        await tick();
        unawaited(d.stop());
        await tick();
        expect(replies, hasLength(1));
        replies[0].complete(answer(200, '{"text":" one "}'));
        await tick();
        expect(replies, hasLength(2));
        replies[1].complete(answer(200, '{"text":"two"}'));
        await tick();
        expect(sizes.fold(0, (a, b) => a + b), rec.wav.length + 44);
        expect(
          events.whereType<DictationWorking>().map((e) => (e.part, e.parts)),
          [(0, 0), (1, 2), (2, 2)],
        );
        expect(events.whereType<DictationFinal>().single.text, 'one two');
        expect(events.last, isA<DictationEnd>());
      },
    );

    test('a part that fails is tried once more', () async {
      final statuses = [500, 200, 200];
      final d = HostDictation(
        () =>
            (m, p, {headers, body}) async =>
                answer(statuses.removeAt(0), '{"text":"ok"}'),
      );
      final events = <DictationEvent>[];
      d.listen('en').listen(events.add);
      await tick();
      await d.stop();
      await tick();
      expect(statuses, isEmpty);
      expect(events.whereType<DictationFinal>().single.text, 'ok ok');
      expect(events.whereType<DictationError>(), isEmpty);
    });

    testWidgets('a dropped connection is tried again after a moment', (
      t,
    ) async {
      var posts = 0;
      final d = HostDictation(
        () => (m, p, {headers, body}) async {
          if (posts++ == 0) throw StreamClosed(1000);
          return answer(200, '{"text":"ok"}');
        },
      );
      final events = <DictationEvent>[];
      d.listen('en').listen(events.add);
      await t.pump();
      unawaited(d.stop());
      await t.pump();
      await t.pump(const Duration(milliseconds: 500));
      expect(posts, 1);
      await t.pump(const Duration(seconds: 2));
      expect(posts, 3);
      expect(events.whereType<DictationFinal>().single.text, 'ok ok');
    });

    test(
      'a part failing twice: the parts before it are kept, the cut is told',
      () async {
        final statuses = [200, 500, 500];
        final d = HostDictation(
          () =>
              (m, p, {headers, body}) async =>
                  answer(statuses.removeAt(0), '{"text":"one"}'),
        );
        final events = <DictationEvent>[];
        d.listen('en').listen(events.add);
        await tick();
        await d.stop();
        await tick();
        expect(events.whereType<DictationFinal>().single.text, 'one');
        expect(
          events.whereType<DictationError>().single.why,
          DictationFailure.cut,
        );
        expect(events.last, isA<DictationEnd>());
      },
    );

    test(
      'the first part failing twice is hostFailed with nothing kept',
      () async {
        var posts = 0;
        final d = HostDictation(
          () => (m, p, {headers, body}) async {
            posts++;
            return answer(500);
          },
        );
        final events = <DictationEvent>[];
        d.listen('en').listen(events.add);
        await tick();
        await d.stop();
        await tick();
        expect(posts, 2);
        expect(events.whereType<DictationFinal>(), isEmpty);
        expect(
          events.whereType<DictationError>().single.why,
          DictationFailure.hostFailed,
        );
      },
    );

    test('a cancel between parts sends no more', () async {
      final replies = <Completer<HttpAnswer>>[];
      final d = HostDictation(
        () => (m, p, {headers, body}) {
          replies.add(Completer<HttpAnswer>());
          return replies.last.future;
        },
      );
      final events = <DictationEvent>[];
      d.listen('en').listen(events.add);
      await tick();
      unawaited(d.stop());
      await tick();
      await d.cancel();
      replies[0].complete(answer(200, '{"text":"one"}'));
      await tick();
      expect(replies, hasLength(1));
      expect(events.whereType<DictationFinal>(), isEmpty);
    });
  });
}
