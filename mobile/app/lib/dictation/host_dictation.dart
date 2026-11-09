// Dictation by the host: the phone records (MainActivity's `nb/record`) and the host's Whisper transcribes.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';

import '../media/media_comment.dart';
import 'dictation.dart';
import 'wav_parts.dart';

// `start`, `stop` (answers the WAV bytes) and `cancel`; the phone calls back `level` (0..1, about every 100 ms
// while recording) and `capped` when the recorder reached
// its limit and stopped itself with the audio kept.
const recordChannel = MethodChannel('nb/record');

// a hung request must not keep the spinner up; a long recording (or one queued behind another, or the model's cold
// load) gets twice its own length on top
const _postTimeout = Duration(seconds: 60);

// 16 kHz 16-bit mono after the 44-byte header: 32 bytes a millisecond
Duration _timeoutFor(Uint8List wav) =>
    _postTimeout +
    Duration(milliseconds: (wav.length - 44).clamp(0, 1 << 30) ~/ 32 * 2);

const _retryAfter = Duration(seconds: 2);

enum _Phase { idle, recording, posting, done }

class HostDictation implements Dictation {
  HostDictation(this._http, {this.onHostOff});

  /// Called when the host answers 503: its Whisper is off or gone.
  final void Function()? onHostOff;

  /// The window's requests; null while the host is offline.
  final WindowHttp? Function() _http;

  _Phase _phase = _Phase.idle;
  StreamController<DictationEvent>? _out;
  String _lang = 'en';

  @override
  Stream<DictationEvent> listen(String lang) {
    _lang = lang;
    final out = _out = StreamController<DictationEvent>();
    out.onListen = () async {
      if (_http() == null) return _finish(DictationFailure.hostFailed);
      _phase = _Phase.recording;
      recordChannel.setMethodCallHandler((call) async {
        if (call.method == 'capped') await stop();
        if (call.method == 'level' && _phase == _Phase.recording) {
          final v = call.arguments;
          if (v is num) _out?.add(DictationLevel(v.toDouble()));
        }
        // the recorder failed under the phone: nothing usable was kept
        if (call.method == 'failed' && _phase == _Phase.recording) {
          _finish(DictationFailure.failed);
          await recordChannel.invokeMethod<void>('cancel').catchError((_) {});
        }
      });
      try {
        await recordChannel.invokeMethod<void>('start');
      } on PlatformException catch (e) {
        _finish(
          e.code == 'denied'
              ? DictationFailure.denied
              : DictationFailure.failed,
        );
      }
    };
    return out.stream;
  }

  @override
  Future<void> stop() async {
    final out = _out;
    if (_phase != _Phase.recording || out == null) return;
    _phase = _Phase.posting;
    out.add(const DictationWorking());
    try {
      final wav = await recordChannel.invokeMethod<Uint8List>('stop');
      final http = _http();
      if (_phase != _Phase.posting) return;
      if (wav == null || http == null) {
        // the recorder may still start once a permission prompt is answered: nobody would own it
        if (wav == null) {
          await recordChannel.invokeMethod<void>('cancel').catchError((_) {});
        }
        return _finish(DictationFailure.hostFailed);
      }
      final parts = splitWav(wav);
      final texts = <String>[];
      for (var i = 0; i < parts.length; i++) {
        if (parts.length > 1) {
          out.add(DictationWorking(part: i + 1, parts: parts.length));
        }
        final r = await _post(parts[i]);
        if (_phase != _Phase.posting) return;
        if (r?.status == 200) {
          texts.add(r!.text);
          continue;
        }
        final off = r?.status == 503;
        if (off) onHostOff?.call();
        // what came before the failed part is kept; the rest is said to be lost
        final kept = texts.where((t) => t.isNotEmpty).join(' ');
        if (kept.isEmpty) {
          return _finish(
            off ? DictationFailure.hostOff : DictationFailure.hostFailed,
          );
        }
        out.add(DictationFinal(kept));
        return _finish(off ? DictationFailure.hostOff : DictationFailure.cut);
      }
      final text = texts.where((t) => t.isNotEmpty).join(' ');
      if (text.isEmpty) return _finish(DictationFailure.noMatch);
      out.add(DictationFinal(text));
      _finish();
    } catch (_) {
      if (_phase == _Phase.posting) _finish(DictationFailure.hostFailed);
    }
  }

  // One part to the window's Whisper, tried once more (2 s later after a dropped connection) after a failure other
  // than 503 or the timeout: a hung host would only queue the second try behind the first. Null when it did not
  // answer.
  Future<({int status, String text})?> _post(Uint8List wav) async {
    for (var tries = 0; ; tries++) {
      final http = _http();
      if (http == null) return null;
      try {
        final r = await http(
          'POST',
          '/dictation/transcribe?lang=${Uri.encodeQueryComponent(_lang)}',
          headers: {'content-type': 'audio/wav'},
          body: wav,
        ).timeout(_timeoutFor(wav));
        if (r.status == 200) {
          final text = (jsonDecode(utf8.decode(r.body)) as Map)['text'];
          return (status: 200, text: text is String ? text.trim() : '');
        }
        if (r.status == 503 || tries > 0) return (status: r.status, text: '');
      } on TimeoutException {
        return null;
      } catch (_) {
        if (tries > 0) return null;
        // a dropped connection through the relay comes back in a moment, not at once
        await Future<void>.delayed(_retryAfter);
      }
      if (_phase != _Phase.posting) return null;
    }
  }

  @override
  Future<void> cancel() async {
    final was = _phase;
    _close();
    if (was == _Phase.recording || was == _Phase.posting) {
      await recordChannel.invokeMethod<void>('cancel');
    }
  }

  // An error or the result, then the end.
  void _finish([DictationFailure? why]) {
    final out = _out;
    if (why != null) out?.add(DictationError(why));
    out?.add(const DictationEnd());
    _close();
  }

  void _close() {
    _phase = _Phase.done;
    recordChannel.setMethodCallHandler(null);
    _out?.close();
    _out = null;
  }
}
