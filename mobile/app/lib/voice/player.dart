// Plays voice messages through MainActivity's `nb/play`: `play {path, from}` (from ms; a paused file of that path
// resumes), `pause`, `seek {ms}`, `stop`, and `dir` (the folder of the cached files). The phone calls back
// `position {ms}` about every 100 ms while playing, and `done` at the end; `play` answers the file's length in ms.
// One sound plays at a time, across the voice bubbles, the recorder's clips and the sounds embedded in replies; the
// player is the one all of them listen to.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../store/storage.dart' show playChannel;
import 'files.dart';
import 'recorder.dart' show Microphone;

export '../store/storage.dart' show playChannel;
export 'files.dart' show DiskVoiceFiles, VoiceFiles;

/// The bytes of a voice, fetched when it is not cached yet.
typedef LoadVoice = Future<Uint8List?> Function();

/// The file on the phone a sound plays from, had when it starts; null when it cannot be had. [abandoned] completes when
/// the start is left for another sound or a stop (a read in progress stops then: issue 452).
typedef OpenSound = Future<String?> Function(Future<void> abandoned);

/// How a tap or a drag on a sound ended.
enum SoundStart {
  playing,
  paused,

  /// it had the speaker and only moved (or, still loading, will start there)
  moved,

  /// another sound or a stop came first: nothing to say about this one
  left,

  /// its file could not be had
  noFile,

  /// the phone's player could not play its file
  unplayable,

  /// the microphone is recording
  blocked,
}

class VoicePlayer extends ChangeNotifier implements Sounds {
  VoicePlayer({VoiceFiles? files}) : files = files ?? DiskVoiceFiles();

  /// The player every bubble uses; a test puts its own.
  static VoicePlayer shared = VoicePlayer();

  @override
  final VoiceFiles files;

  /// The voice that has the speaker: loading, playing or paused; null when none.
  String? id;
  bool playing = false;
  bool loading = false;
  Duration position = Duration.zero;
  bool _loaded = false;
  int _turn = 0;

  // completed when the current start is left
  Completer<void>? _abandon;

  /// The next start or stop: a start still in progress is left.
  int _next() {
    _abandon?.complete();
    _abandon = null;
    return ++_turn;
  }

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
  OpenSound _cached(String voice, LoadVoice load) => (_) async {
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
      _next();
      _reset();
      notifyListeners();
    }
  }

  /// Play [voice] from its start, or pause/resume it when it already has the speaker.
  Future<SoundStart> toggle(String voice, LoadVoice load) =>
      _toggle(voice, _cached(voice, load), music: false);

  /// Play [voice] from [to], or move to it when it has the speaker.
  Future<SoundStart> seek(String voice, LoadVoice load, Duration to) =>
      _seek(voice, _cached(voice, load), to, music: false);

  /// [toggle] of a sound whose file [open] has (a project's sound, fetched again each time it starts), played as music.
  Future<SoundStart> toggleSound(String sound, OpenSound open) =>
      _toggle(sound, open, music: true);

  /// [seek] of a sound whose file [open] has.
  Future<SoundStart> seekSound(String sound, OpenSound open, Duration to) =>
      _seek(sound, open, to, music: true);

  Future<SoundStart> _toggle(
    String sound,
    OpenSound open, {
    required bool music,
  }) async {
    // a second tap while it loads changes nothing
    if (id == sound && loading) return SoundStart.moved;
    if (id == sound && _loaded) {
      if (playing) {
        playing = false;
        notifyListeners();
        await _call('pause');
        return SoundStart.paused;
      }
      return _start(sound, open, position, music: music);
    }
    return _start(sound, open, Duration.zero, music: music);
  }

  Future<SoundStart> _seek(
    String sound,
    OpenSound open,
    Duration to, {
    required bool music,
  }) async {
    // dragging over a voice that is still being fetched only moves where it will start
    if (id == sound && loading) {
      position = _target = to;
      notifyListeners();
      return SoundStart.moved;
    }
    if (id == sound && _loaded) {
      position = to;
      notifyListeners();
      await _call('seek', {'ms': to.inMilliseconds});
      return SoundStart.moved;
    }
    return _start(sound, open, to, music: music);
  }

  Future<SoundStart> _start(
    String voice,
    OpenSound open,
    Duration from, {
    required bool music,
  }) async {
    // the microphone would hear it, and a recording is not interrupted by a bubble
    if (Microphone.hot.value) return SoundStart.blocked;
    _target = null;
    final turn = _next();
    final abandon = _abandon = Completer<void>();
    final other = id != null && id != voice;
    if (other) await _call('stop');
    // a stop, or another sound, came while the last one was being stopped
    if (turn != _turn) return SoundStart.left;
    final resumed = _loaded && !other ? _path : null;
    if (!_loaded || other) {
      id = voice;
      position = from;
      loading = true;
      playing = false;
      _loaded = false;
      notifyListeners();
    }
    String? path;
    try {
      path = resumed ?? await open(abandon.future);
    } on Object {
      path = null;
    }
    // another voice, or a stop, came while this one was fetched
    if (turn != _turn) return SoundStart.left;
    if (path == null) {
      _fail();
      return SoundStart.noFile;
    }
    _path = path;
    final start = _target ?? from;
    _target = null;
    playChannel.setMethodCallHandler(_onCall);
    try {
      final length = await playChannel.invokeMethod<Object?>('play', {
        'path': path,
        'from': start.inMilliseconds,
        if (music) 'music': true,
      });
      if (length is num && length > 0) {
        _lengths[voice] = Duration(milliseconds: length.round());
      }
    } on Object {
      if (turn != _turn) return SoundStart.left;
      _fail();
      return SoundStart.unplayable;
    }
    if (turn != _turn) return SoundStart.left;
    loading = false;
    _loaded = true;
    playing = true;
    notifyListeners();
    return SoundStart.playing;
  }

  void _fail() {
    _abandon = null;
    _reset();
    notifyListeners();
  }

  Future<dynamic> _onCall(MethodCall call) async {
    if (call.method == 'position' && _loaded) {
      final ms = (call.arguments as Map)['ms'];
      if (ms is num) position = Duration(milliseconds: ms.round());
      notifyListeners();
    } else if (call.method == 'done') {
      _next();
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
    _next();
    _reset();
    notifyListeners();
    await _call('stop');
  }

  /// Stops [voice] if it has the speaker, and forgets its file.
  @override
  Future<void> drop(String voice) async {
    if (id == voice) await stop();
    await files.delete(voice).catchError((Object _) {});
  }
}
