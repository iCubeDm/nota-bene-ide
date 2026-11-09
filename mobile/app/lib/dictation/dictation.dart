// A voice session's events: the phone records, the window's Whisper transcribes (host_dictation.dart).
// cut: the parts after the first that failed were not transcribed; the text before it came first
enum DictationFailure { denied, noMatch, failed, hostFailed, hostOff, cut }

sealed class DictationEvent {
  const DictationEvent();
}

/// The speech is being transcribed; a long recording says which of its [parts] is (from 1), else both are 0.
class DictationWorking extends DictationEvent {
  const DictationWorking({this.part = 0, this.parts = 0});
  final int part, parts;
}

class DictationFinal extends DictationEvent {
  const DictationFinal(this.text);
  final String text;
}

/// The input level, 0..1, while recording.
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
  /// Starts one session in [lang] (an ISO 639 code); the stream ends with [DictationEnd], after a [DictationFinal]
  /// or [DictationError].
  Stream<DictationEvent> listen(String lang);

  /// Asks for the final result of what was said so far.
  Future<void> stop();

  /// Ends the session without a result.
  Future<void> cancel();
}
