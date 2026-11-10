// The phone's recorder, MainActivity's `nb/record`: `start`, `stop` (answers the 16 kHz 16-bit mono WAV) and
// `cancel`; the phone calls back `level` (0..1, about every 100 ms while recording), `capped` when the recorder
// reached its 10 minutes and stopped itself with the audio kept, and `failed` when a read error ended it.

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const recordChannel = MethodChannel('nb/record');

/// Who has the one native recorder: a session from its first moment to its end (the preview included), and whether it
/// is recording now. Another button stays off meanwhile, and nothing plays into the microphone.
class Microphone {
  static final owner = ValueNotifier<Object?>(null);
  static final hot = ValueNotifier<bool>(false);
}

enum RecordFailure { denied, failed, cancelled }

class RecordError implements Exception {
  RecordError(this.why);
  final RecordFailure why;
  @override
  String toString() => 'RecordError($why)';
}

class VoiceRecorder {
  VoiceRecorder({this.onLevel, this.onCapped, this.onFailed});

  final void Function(double level)? onLevel;
  final void Function()? onCapped;
  final void Function()? onFailed;

  Future<dynamic> _on(MethodCall call) async {
    switch (call.method) {
      case 'level':
        final v = call.arguments;
        if (v is num) onLevel?.call(v.toDouble());
      case 'capped':
        onCapped?.call();
      case 'failed':
        onFailed?.call();
    }
  }

  void _detach() => recordChannel.setMethodCallHandler(null);

  /// Starts recording; throws [RecordError] (`denied` for the microphone permission, `cancelled` when a `cancel` came
  /// while the permission was asked).
  Future<void> start() async {
    recordChannel.setMethodCallHandler(_on);
    try {
      await recordChannel.invokeMethod<void>('start');
    } on PlatformException catch (e) {
      _detach();
      throw RecordError(switch (e.code) {
        'denied' => RecordFailure.denied,
        'cancelled' => RecordFailure.cancelled,
        _ => RecordFailure.failed,
      });
    }
  }

  /// The recording as a WAV; null when the recorder has none.
  Future<Uint8List?> stop() async {
    try {
      return await recordChannel.invokeMethod<Uint8List>('stop');
    } on PlatformException {
      return null;
    } finally {
      _detach();
    }
  }

  Future<void> cancel() async {
    _detach();
    try {
      await recordChannel.invokeMethod<void>('cancel');
    } on PlatformException {
      // nothing to cancel
    }
  }
}
