// Plays voice messages through MainActivity's `nb/play`: `play {path, from}` (from ms; a paused file of that path
// resumes), `pause`, `seek {ms}`, `stop`, and `dir` (the folder of the cached files). The phone calls back
// `position {ms}` about every 100 ms while playing, and `done` at the end; `play` answers the file's length in ms.
// One sound plays at a time, across the voice bubbles, the recorder's clips and the sounds embedded in replies; the
// player is the one all of them listen to.
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'recorder.dart' show Microphone;

const playChannel = MethodChannel('nb/play');

/// The bytes of a voice, fetched when it is not cached yet.
typedef LoadVoice = Future<Uint8List?> Function();

/// The file on the phone a sound plays from, had when it starts; null when it cannot be had.
typedef OpenSound = Future<String?> Function();

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

  // the file of the sound that has the speaker: a resume plays it again, not a fresh one
  String? _path;

  // where a drag over a voice that is still loading wants to play from
  Duration? _target;

  // the lengths the player told, by sound
  final _lengths = <String, Duration>{};

  bool isCurrent(String voice) => id == voice;

  /// [sound]'s length, once it has played; null before (or when the player could not tell).
  Duration? lengthOf(String sound) => _lengths[sound];

  // a voice: its cached WAV, fetched and kept when it is not there
  OpenSound _cached(String voice, LoadVoice load) => () async {
    final path = await files.find(voice);
    if (path != null) return path;
    final bytes = await load();
    return bytes == null ? null : files.save(voice, bytes);
  };

  void _reset() {
    id = null;
    playing = loading = _loaded = false;
    _path = null;
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
  Future<void> toggle(String voice, LoadVoice load) =>
      toggleSound(voice, _cached(voice, load));

  /// Play [voice] from [to], or move to it when it has the speaker.
  Future<void> seek(String voice, LoadVoice load, Duration to) =>
      seekSound(voice, _cached(voice, load), to);

  /// [toggle] of a sound whose file [open] has (a project's sound, fetched again each time it starts).
  Future<void> toggleSound(String sound, OpenSound open) async {
    // a second tap while it loads changes nothing
    if (id == sound && loading) return;
    if (id == sound && _loaded) {
      if (playing) {
        playing = false;
        notifyListeners();
        return _call('pause');
      }
      return _start(sound, open, position);
    }
    return _start(sound, open, Duration.zero);
  }

  /// [seek] of a sound whose file [open] has.
  Future<void> seekSound(String sound, OpenSound open, Duration to) async {
    // dragging over a voice that is still being fetched only moves where it will start
    if (id == sound && loading) {
      position = _target = to;
      notifyListeners();
      return;
    }
    if (id == sound && _loaded) {
      position = to;
      notifyListeners();
      return _call('seek', {'ms': to.inMilliseconds});
    }
    return _start(sound, open, to);
  }

  Future<void> _start(String voice, OpenSound open, Duration from) async {
    // the microphone would hear it, and a recording is not interrupted by a bubble
    if (Microphone.hot.value) return;
    _target = null;
    final turn = ++_turn;
    final other = id != null && id != voice;
    if (other) await _call('stop');
    final resumed = _loaded && !other ? _path : null;
    if (!_loaded || other) {
      id = voice;
      position = from;
      loading = true;
      playing = false;
      _loaded = false;
      notifyListeners();
    }
    try {
      final path = resumed ?? await open();
      if (path == null) throw StateError('no audio');
      // another voice, or a stop, came while this one was fetched
      if (turn != _turn) return;
      _path = path;
      final start = _target ?? from;
      _target = null;
      playChannel.setMethodCallHandler(_onCall);
      final length = await playChannel.invokeMethod<Object?>('play', {
        'path': path,
        'from': start.inMilliseconds,
      });
      if (length is num && length > 0) {
        _lengths[voice] = Duration(milliseconds: length.round());
      }
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
