import 'dart:async';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

// The phone's speech recognizer (MainActivity's `nb/speech` channel; its events come on `nb/speech/events`).
const speechChannel = MethodChannel('nb/speech');
const speechEvents = EventChannel('nb/speech/events');

enum DictationFailure {
  denied,
  unavailable,
  noMatch,
  failed,
  hostFailed,
  hostOff,
}

sealed class DictationEvent {
  const DictationEvent();
}

/// What has been recognized so far; it may still change.
class DictationPartial extends DictationEvent {
  const DictationPartial(this.text);
  final String text;
}

/// The speech is being transcribed; nothing more to say until the result.
class DictationWorking extends DictationEvent {
  const DictationWorking();
}

class DictationFinal extends DictationEvent {
  const DictationFinal(this.text);
  final String text;
}

/// The input level, 0..1, while listening or recording.
class DictationLevel extends DictationEvent {
  const DictationLevel(this.value);
  final double value;
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
    // Finished stretches of speech; the recognizer restarts after each pause.
    var done = '';
    String join(String text) => done.isEmpty ? text : '$done $text'.trim();
    StreamSubscription<Object?>? native;
    out = StreamController<DictationEvent>(
      onListen: () async {
        // Subscribe before `start`, so no early event is missed.
        native = speechEvents.receiveBroadcastStream().listen(
          (raw) {
            var event = _decode(raw);
            if (event == null) return;
            if (raw is Map && raw['type'] == 'segment') {
              done = join((raw['text'] as String? ?? '').trim());
              event = DictationPartial(done);
            } else if (event is DictationPartial) {
              event = DictationPartial(join(event.text));
            } else if (event is DictationFinal) {
              event = DictationFinal(join(event.text.trim()));
            }
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
    'level' => DictationLevel(((raw['value'] as num?) ?? 0).toDouble()),
    'segment' => DictationPartial(text is String ? text : ''),
    'end' => const DictationEnd(),
    _ => null,
  };
}

Dictation _dictation = PlatformDictation();
Dictation get dictation => _dictation;
@visibleForTesting
set dictation(Dictation value) => _dictation = value;

/// The recognizer's language: the tag of the first device locale in the UI language (so its region is kept),
/// else the UI language alone. Bare zh and pt name no single variant, so they get zh-CN and pt-BR.
String speechTag(String uiLang, List<Locale> devices) {
  for (final d in devices) {
    if (d.languageCode != uiLang) continue;
    final region = d.countryCode;
    if (region != null && region.isNotEmpty) return '$uiLang-$region';
    break;
  }
  return switch (uiLang) {
    'zh' => 'zh-CN',
    'pt' => 'pt-BR',
    _ => uiLang,
  };
}
