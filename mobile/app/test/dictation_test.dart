import 'dart:ui';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/dictation/dictation.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  // An EventChannel's listen/cancel travel over a method channel of the same name.
  const eventCalls = MethodChannel('nb/speech/events');
  final calls = <MethodCall>[];
  // Events the fake native side emits once Dart starts listening.
  var events = <Object?>[];

  setUp(() {
    calls.clear();
    events = [];
    messenger.setMockMethodCallHandler(speechChannel, (call) async {
      calls.add(call);
      return null;
    });
    messenger.setMockMethodCallHandler(eventCalls, (call) async {
      if (call.method == 'listen') {
        for (final e in events) {
          messenger.handlePlatformMessage(
            speechEvents.name,
            const StandardMethodCodec().encodeSuccessEnvelope(e),
            (_) {},
          );
        }
      }
      return null;
    });
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(speechChannel, null);
    messenger.setMockMethodCallHandler(eventCalls, null);
  });

  test('listen starts a session in the language and maps its events', () async {
    events = [
      {'type': 'partial', 'text': 'hel'},
      {'type': 'final', 'text': 'hello'},
      {'type': 'end'},
    ];

    final got = await PlatformDictation().listen('ru-RU').toList();

    expect(calls.single.method, 'start');
    expect(calls.single.arguments, {'lang': 'ru-RU'});
    expect(got, hasLength(3));
    expect((got[0] as DictationPartial).text, 'hel');
    expect((got[1] as DictationFinal).text, 'hello');
    expect(got[2], isA<DictationEnd>());
  });

  test('error codes map to failures', () async {
    events = [
      {'type': 'error', 'code': 'denied'},
      {'type': 'error', 'code': 'unavailable'},
      {'type': 'error', 'code': 'no_match'},
      {'type': 'error', 'code': 'other'},
      {'type': 'error', 'code': 'surprise'},
      {'type': 'end'},
    ];

    final got = await PlatformDictation().listen('en').toList();

    expect(got.whereType<DictationError>().map((e) => e.why), [
      DictationFailure.denied,
      DictationFailure.unavailable,
      DictationFailure.noMatch,
      DictationFailure.failed,
      DictationFailure.failed,
    ]);
    expect(got.last, isA<DictationEnd>());
  });

  test('stop and cancel call their methods', () async {
    final d = PlatformDictation();
    await d.stop();
    await d.cancel();
    expect(calls.map((c) => c.method), ['stop', 'cancel']);
  });

  test('speechTag takes the first device locale in the UI language', () {
    expect(speechTag('ru', const [Locale('ru', 'RU')]), 'ru-RU');
    expect(speechTag('de', const [Locale('en', 'US')]), 'de');
    expect(speechTag('en', const [Locale('en')]), 'en');
    // a later device locale still counts, the first matching one wins
    expect(
      speechTag('de', const [
        Locale('en', 'US'),
        Locale('de', 'AT'),
        Locale('de', 'DE'),
      ]),
      'de-AT',
    );
  });

  test('speechTag gives zh and pt a region when the device has none', () {
    expect(speechTag('zh', const [Locale('zh')]), 'zh-CN');
    expect(speechTag('zh', const [Locale('en', 'US')]), 'zh-CN');
    expect(speechTag('zh', const [Locale('zh', 'TW')]), 'zh-TW');
    expect(speechTag('pt', const [Locale('pt')]), 'pt-BR');
    expect(speechTag('pt', const [Locale('pt', 'PT')]), 'pt-PT');
  });
}
