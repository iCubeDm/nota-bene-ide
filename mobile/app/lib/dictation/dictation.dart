import 'dart:async';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

// The phone's speech recognizer (MainActivity's `nb/speech` channel; its events come on `nb/speech/events`).
const speechChannel = MethodChannel('nb/speech');
const speechEvents = EventChannel('nb/speech/events');

enum DictationFailure { denied, unavailable, noMatch, failed }

sealed class DictationEvent {
  const DictationEvent();
}

/// What has been recognized so far; it may still change.
class DictationPartial extends DictationEvent {
  const DictationPartial(this.text);
  final String text;
}

class DictationFinal extends DictationEvent {
  const DictationFinal(this.text);
  final String text;
}

class DictationError extends DictationEvent {
  const DictationError(this.why);
  final DictationFailure why;
}

/// The session is over; always the last event.
class DictationEnd extends DictationEvent {
  const DictationEnd();
}

abstract class Dictation {
  /// Starts one session; the stream ends with [DictationEnd], after a [DictationFinal] or [DictationError].
  Stream<DictationEvent> listen(String languageTag);

  /// Asks for the final result of what was said so far.
  Future<void> stop();

  /// Ends the session without a result.
  Future<void> cancel();
}

class PlatformDictation implements Dictation {
  @override
  Stream<DictationEvent> listen(String languageTag) {
    late final StreamController<DictationEvent> out;
    StreamSubscription<Object?>? native;
    out = StreamController<DictationEvent>(
      onListen: () async {
        // Subscribe before `start`, so no early event is missed.
        native = speechEvents.receiveBroadcastStream().listen(
          (raw) {
            final event = _decode(raw);
            if (event == null) return;
            out.add(event);
            if (event is DictationEnd) out.close();
          },
          onError: (Object _) {
            out.add(const DictationError(DictationFailure.failed));
            out.add(const DictationEnd());
            out.close();
          },
        );
        try {
          await speechChannel.invokeMethod<void>('start', {
            'lang': languageTag,
          });
        } on PlatformException {
          out.add(const DictationError(DictationFailure.failed));
          out.add(const DictationEnd());
          out.close();
        }
      },
      onCancel: () => native?.cancel(),
    );
    return out.stream;
  }

  @override
  Future<void> stop() => speechChannel.invokeMethod<void>('stop');

  @override
  Future<void> cancel() => speechChannel.invokeMethod<void>('cancel');
}

DictationEvent? _decode(Object? raw) {
  if (raw is! Map) return null;
  final text = raw['text'];
  return switch (raw['type']) {
    'partial' => DictationPartial(text is String ? text : ''),
    'final' => DictationFinal(text is String ? text : ''),
    'error' => DictationError(switch (raw['code']) {
      'denied' => DictationFailure.denied,
      'unavailable' => DictationFailure.unavailable,
      'no_match' => DictationFailure.noMatch,
      _ => DictationFailure.failed,
    }),
    'end' => const DictationEnd(),
    _ => null,
  };
}

Dictation _dictation = PlatformDictation();
Dictation get dictation => _dictation;
@visibleForTesting
set dictation(Dictation value) => _dictation = value;

/// The recognizer's language: the device's own tag (with its region) when its language is the UI language,
/// else the UI language alone.
String speechTag(String uiLang, Locale device) {
  if (device.languageCode != uiLang) return uiLang;
  final region = device.countryCode;
  return region == null || region.isEmpty ? uiLang : '$uiLang-$region';
}
