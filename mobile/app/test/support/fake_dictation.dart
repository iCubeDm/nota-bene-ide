import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/dictation/dictation.dart';
import 'package:nb_app/dictation/voice_button.dart';

class FakeDictation implements Dictation {
  final sessions = <StreamController<DictationEvent>>[];
  final tags = <String>[];
  final calls = <String>[];

  StreamController<DictationEvent> get last => sessions.last;

  @override
  Stream<DictationEvent> listen(String languageTag) {
    tags.add(languageTag);
    calls.add('listen');
    final c = StreamController<DictationEvent>();
    sessions.add(c);
    return c.stream;
  }

  @override
  Future<void> stop() async => calls.add('stop');

  @override
  Future<void> cancel() async => calls.add('cancel');
}

class ThrowingDictation extends FakeDictation {
  @override
  Future<void> stop() async => throw PlatformException(code: 'x');

  @override
  Future<void> cancel() async => throw PlatformException(code: 'x');
}

/// Presses the voice button and holds it past the 200 ms threshold; the gesture is still down.
Future<TestGesture> pressVoice(WidgetTester t, {Finder? at}) async {
  final g = await t.startGesture(t.getCenter(at ?? find.byType(VoiceButton)));
  await t.pump(const Duration(milliseconds: 250));
  return g;
}

/// Hold, then release: the recording stops.
Future<void> holdVoice(WidgetTester t, {Finder? at}) async {
  final g = await pressVoice(t, at: at);
  await g.up();
  await t.pump();
}

/// Hold, slide up past the lock threshold, release: the recording goes on, locked.
Future<void> lockVoice(WidgetTester t, {Finder? at}) async {
  final g = await pressVoice(t, at: at);
  await g.moveBy(const Offset(0, -100));
  await g.up();
  await t.pump();
}
