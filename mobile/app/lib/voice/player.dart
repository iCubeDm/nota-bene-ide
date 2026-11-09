// Plays voice messages through MainActivity's `nb/play`: `play {path, from}` (from ms; a paused file of that path
// resumes), `pause`, `seek {ms}`, `stop`, and `dir` (the folder of the cached files). The phone calls back
// `position {ms}` about every 100 ms while playing, and `done` at the end. One voice sounds at a time, across the
// bubbles and the clips; the player is the one all of them listen to.
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const playChannel = MethodChannel('nb/play');

/// The bytes of a voice, fetched when it is not cached yet.
typedef LoadVoice = Future<Uint8List?> Function();

/// The WAVs the player has, by voice id.
abstract class VoiceFiles {
  Future<String?> find(String id);
  Future<String> save(String id, Uint8List bytes);
  Future<void> delete(String id);
}

/// In the app's cache dir (the platform clears it when it needs room); the same voice is fetched once.
class DiskVoiceFiles implements VoiceFiles {
  Future<File> _file(String id) async {
    final dir = await playChannel.invokeMethod<String>('dir');
    return File('$dir/${id.replaceAll(RegExp(r'[^0-9A-Za-z_-]'), '_')}.wav');
  }

  @override
  Future<String?> find(String id) async {
    final f = await _file(id);
    return await f.exists() ? f.path : null;
  }

  @override
  Future<String> save(String id, Uint8List bytes) async {
    final f = await _file(id);
    // written aside and renamed: a half-written file must never be taken for the voice
    final part = File('${f.path}.part');
    await part.writeAsBytes(bytes, flush: true);
    await part.rename(f.path);
    return f.path;
  }

  @override
  Future<void> delete(String id) async {
    final f = await _file(id);
    if (await f.exists()) await f.delete();
  }
}

class VoicePlayer extends ChangeNotifier {
  VoicePlayer({VoiceFiles? files}) : files = files ?? DiskVoiceFiles();

  /// The player every bubble uses; a test puts its own.
  static VoicePlayer shared = VoicePlayer();

  final VoiceFiles files;

  /// The voice that has the speaker: loading, playing or paused; null when none.
  String? id;
  bool playing = false;
  bool loading = false;
  Duration position = Duration.zero;
  bool _loaded = false;
  int _turn = 0;

  bool isCurrent(String voice) => id == voice;

  void _reset() {
    id = null;
    playing = loading = _loaded = false;
    position = Duration.zero;
    playChannel.setMethodCallHandler(null);
  }

  Future<void> _call(String method, [Object? args]) async {
    try {
      await playChannel.invokeMethod<void>(method, args);
    } on PlatformException {
      // the player is gone (a failed file): the voice is simply not playing
      _turn++;
      _reset();
      notifyListeners();
    }
  }

  /// Play [voice] from its start, or pause/resume it when it already has the speaker.
  Future<void> toggle(String voice, LoadVoice load) async {
    if (id == voice && _loaded) {
      if (playing) {
        playing = false;
        notifyListeners();
        return _call('pause');
      }
      return _start(voice, load, position);
    }
    return _start(voice, load, Duration.zero);
  }

  /// Play [voice] from [to], or move to it when it has the speaker.
  Future<void> seek(String voice, LoadVoice load, Duration to) async {
    if (id == voice && _loaded) {
      position = to;
      notifyListeners();
      return _call('seek', {'ms': to.inMilliseconds});
    }
    return _start(voice, load, to);
  }

  Future<void> _start(String voice, LoadVoice load, Duration from) async {
    final turn = ++_turn;
    final other = id != null && id != voice;
    if (other) await _call('stop');
    if (!_loaded || other) {
      id = voice;
      position = from;
      loading = true;
      playing = false;
      _loaded = false;
      notifyListeners();
    }
    try {
      var path = await files.find(voice);
      if (path == null) {
        final bytes = await load();
        if (bytes == null) throw StateError('no audio');
        path = await files.save(voice, bytes);
      }
      // another voice, or a stop, came while this one was fetched
      if (turn != _turn) return;
      playChannel.setMethodCallHandler(_onCall);
      await playChannel.invokeMethod<void>('play', {
        'path': path,
        'from': from.inMilliseconds,
      });
      if (turn != _turn) return;
      loading = false;
      _loaded = true;
      playing = true;
    } on Object {
      if (turn != _turn) return;
      _reset();
    }
    notifyListeners();
  }

  Future<dynamic> _onCall(MethodCall call) async {
    if (call.method == 'position' && _loaded) {
      final ms = (call.arguments as Map)['ms'];
      if (ms is num) position = Duration(milliseconds: ms.round());
      notifyListeners();
    } else if (call.method == 'done') {
      _turn++;
      _reset();
      notifyListeners();
    } else if (call.method == 'paused' && _loaded) {
      // the app went out of sight
      playing = false;
      notifyListeners();
    }
  }

  /// Silences whatever plays (a recording starts, a bubble leaves).
  Future<void> stop() async {
    if (id == null) return;
    _turn++;
    _reset();
    notifyListeners();
    await _call('stop');
  }

  /// Stops [voice] if it has the speaker, and forgets its file.
  Future<void> drop(String voice) async {
    if (id == voice) await stop();
    await files.delete(voice).catchError((Object _) {});
  }
}
