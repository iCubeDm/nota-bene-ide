import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/dictation/dictation.dart';
import 'package:nb_app/dictation/host_dictation.dart';
import 'package:nb_app/media/media_comment.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';

/// The phone's recorder (`nb/record`), played by the test.
class Recorder {
  final calls = <String>[];
  Object? startError;
  final wav = Uint8List.fromList([82, 73, 70, 70, 1, 2, 3]);

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(recordChannel, (call) async {
          calls.add(call.method);
          if (call.method == 'start' && startError != null) {
            throw PlatformException(code: startError! as String);
          }
          return call.method == 'stop' ? wav : null;
        });
  }

  /// The recorder stopping itself at its cap.
  Future<void> cap() => TestDefaultBinaryMessengerBinding
      .instance
      .defaultBinaryMessenger
      .handlePlatformMessage(
        recordChannel.name,
        recordChannel.codec.encodeMethodCall(const MethodCall('capped')),
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
    d.listen('ru-RU').listen(events.add);
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

  test('503, offline and a dead connection are hostFailed', () async {
    for (final h in <WindowHttp? Function()>[
      () =>
          (m, p, {headers, body}) async => answer(503),
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

  group('in the composer', () {
    late Rig r;
    setUp(() => r = Rig());
    tearDown(() => r.dispose());

    Future<Completer<HttpAnswer>> openWith(
      WidgetTester t, {
      String? cap = 'whisper',
    }) async {
      await r.open(
        t,
        hello: {
          'kind': 'hello',
          'protocol': 13,
          'capabilities': Rig.caps(dictation: cap),
        },
      );
      final reply = Completer<HttpAnswer>();
      r.ch.onHttp = (port, method, path) => reply.future;
      return reply;
    }

    testWidgets('text lands at the cursor; a spinner shows meanwhile', (
      t,
    ) async {
      final reply = await openWith(t);
      await t.enter('Fix ');
      await t.tap(find.byTooltip('Dictate'));
      await t.pump();
      await t.tap(find.byTooltip('Stop dictation'));
      await t.pump();
      await t.pump();
      expect(find.byTooltip('Transcribing…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await t.tap(find.byTooltip('Transcribing…'));
      await t.pump();
      expect(r.ch.calls.length, 1);
      reply.complete(answer(200, '{"text":"the header"}'));
      await t.pumpAndSettle();
      expect(find.text('Fix the header'), findsOneWidget);
      expect(find.byTooltip('Dictate'), findsOneWidget);
      expect(r.ch.calls.single.path, '/dictation/transcribe?lang=en');
    });

    testWidgets('a 503 leaves the field and says so', (t) async {
      final reply = await openWith(t);
      await t.enter('Fix ');
      await t.tap(find.byTooltip('Dictate'));
      await t.pump();
      await t.tap(find.byTooltip('Stop dictation'));
      await t.pump();
      reply.complete(answer(503));
      await t.pumpAndSettle();
      expect(find.text('Fix '), findsOneWidget);
      expect(find.text('The computer could not transcribe it'), findsOneWidget);
    });

    testWidgets('without the capability the phone recognizes', (t) async {
      final saved = dictation;
      final calls = <String>[];
      dictation = _Phone(calls);
      addTearDown(() => dictation = saved);
      await openWith(t, cap: null);
      await t.tap(find.byTooltip('Dictate'));
      await t.pump();
      expect(calls, ['listen']);
      expect(rec.calls, isEmpty);
    });
  });
}

class _Phone implements Dictation {
  _Phone(this.calls);
  final List<String> calls;
  @override
  Stream<DictationEvent> listen(String languageTag) {
    calls.add('listen');
    return StreamController<DictationEvent>().stream;
  }

  @override
  Future<void> stop() async {}
  @override
  Future<void> cancel() async {}
}
