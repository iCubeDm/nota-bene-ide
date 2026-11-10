// One voice recording, as Telegram's gestures drive it: held (the finger is down: a release sends it, a slide left
// cancels it, a slide up locks it), locked (it goes on without the finger: Send, Stop to the preview, Cancel) and the
// preview (the stopped recording: listen to it, Delete or Send). The button, the row and the host's own widgets
// listen to this one object.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../chat/window_tab.dart' show uuidV4;
import 'player.dart';
import 'recorder.dart';
import 'wav.dart';

enum RecordPhase { idle, recording, locked, preview }

class RecordSession extends ChangeNotifier {
  RecordSession({required this.onRecorded, this.onError});

  /// The recording to send: the WAV and its length.
  /// It may ask the user first (the busy dialog); when it does not take the recording it hands it back by [restore].
  final FutureOr<void> Function(Uint8List wav, Duration length) onRecorded;
  final void Function(RecordFailure why)? onError;

  /// Bumped when the hint of "Hold to record" is due: after a short tap, and after a recording too short to be a
  /// message was dropped.
  final hintAsked = ValueNotifier<int>(0);

  /// Sliding this far left cancels, this far up locks (Telegram's).
  static const cancelAt = 96.0, lockAt = 80.0;

  /// Under this a recording is a slip of the finger.
  static const minLength = Duration(milliseconds: 500);

  /// The recorder stops at 10 minutes; the timer warns from 9:50.
  static const warnAt = Duration(minutes: 9, seconds: 50);

  RecordPhase phase = RecordPhase.idle;
  Duration elapsed = Duration.zero;

  /// The input level, 0..1, smoothed for the halo.
  double level = 0;

  /// How far the finger has moved from where it went down (only left and up are used).
  Offset drag = Offset.zero;

  /// The stopped recording, in the preview.
  Uint8List? wav;
  String previewId = '';

  /// The preview's wave, drawn once when the recording stops.
  List<int> wave = const [];

  bool get active => phase != RecordPhase.idle;

  /// The finger is on the button.
  bool get holding => _held;
  Duration get length =>
      wav == null ? elapsed : Duration(milliseconds: wavMs(wav!));

  VoiceRecorder? _rec;
  Timer? _clock;
  Completer<bool>? _ready;
  bool _held = false;
  bool _ending = false;

  @visibleForTesting
  void debugElapsed(Duration d) {
    elapsed = d;
    notifyListeners();
  }

  /// The finger has been down long enough: start the recorder.
  Future<void> begin() async {
    if (active) return;
    // one native recorder for the whole app
    final mine = Microphone.owner.value;
    if (mine != null && !identical(mine, this)) return;
    Microphone.owner.value = this;
    Microphone.hot.value = true;
    phase = RecordPhase.recording;
    elapsed = Duration.zero;
    level = 0;
    drag = Offset.zero;
    wav = null;
    _held = true;
    _ending = false;
    HapticFeedback.lightImpact();
    // the microphone would hear a voice that is still playing
    unawaited(VoicePlayer.shared.stop());
    final rec = _rec = VoiceRecorder(
      onLevel: (v) {
        level = level * .5 + v.clamp(0, 1) * .5;
        notifyListeners();
      },
      onCapped: _capped,
      onFailed: _failed,
    );
    final ready = _ready = Completer<bool>();
    notifyListeners();
    try {
      await rec.start();
    } on RecordError catch (e) {
      if (!ready.isCompleted) ready.complete(false);
      if (!identical(_rec, rec)) return;
      _reset();
      if (e.why != RecordFailure.cancelled) onError?.call(e.why);
      return;
    }
    if (!identical(_rec, rec)) {
      ready.complete(false);
      return;
    }
    _clock = Timer.periodic(const Duration(milliseconds: 100), (_) {
      elapsed += const Duration(milliseconds: 100);
      level *= .8;
      notifyListeners();
    });
    ready.complete(true);
  }

  /// A recording that starts locked, without a finger (TalkBack's tap).
  Future<void> beginLocked() async {
    await begin();
    if (phase != RecordPhase.recording) return;
    _held = false;
    phase = RecordPhase.locked;
    notifyListeners();
  }

  /// The finger moved to [total] from where it went down.
  void moveBy(Offset total) {
    if (phase != RecordPhase.recording || !_held) return;
    drag = Offset(total.dx.clamp(-cancelAt, 0), total.dy.clamp(-lockAt, 0));
    if (total.dx <= -cancelAt) {
      HapticFeedback.mediumImpact();
      cancel();
    } else if (-total.dy >= lockAt) {
      HapticFeedback.mediumImpact();
      _held = false;
      phase = RecordPhase.locked;
      drag = Offset.zero;
      notifyListeners();
    } else {
      notifyListeners();
    }
  }

  /// The finger went up on a held recording: it is sent.
  Future<void> release() async {
    if (phase != RecordPhase.recording || !_held) return;
    _held = false;
    final ready = _ready;
    if (ready != null && !await ready.future) return;
    if (phase != RecordPhase.recording) return;
    await _end(send: true);
  }

  /// Send, in the locked state or the preview.
  Future<void> send() async {
    if (phase == RecordPhase.preview) return _deliver(wav!);
    if (phase == RecordPhase.locked) await _end(send: true);
  }

  /// Stop, in the locked state: the recording waits in the preview.
  Future<void> stopToPreview() async {
    if (phase == RecordPhase.locked) await _end(send: false);
  }

  /// Drops the recording (the slide, Cancel, Delete): nothing is sent.
  void cancel() {
    final rec = _rec;
    final id = previewId;
    if (rec != null) unawaited(rec.cancel());
    if (id.isNotEmpty) unawaited(VoicePlayer.shared.drop(id));
    _reset();
  }

  void _capped() {
    if (phase == RecordPhase.recording && _held) {
      unawaited(_end(send: true));
    } else if (phase == RecordPhase.recording || phase == RecordPhase.locked) {
      unawaited(_end(send: false));
    }
  }

  void _failed() {
    if (!active) return;
    cancel();
    onError?.call(RecordFailure.failed);
  }

  Future<void> _end({required bool send}) async {
    final rec = _rec;
    if (rec == null || _ending) return;
    _ending = true;
    _clock?.cancel();
    _clock = null;
    final bytes = await rec.stop();
    if (!identical(_rec, rec)) return;
    _rec = null;
    if (bytes == null || bytes.length <= wavHeader) {
      _reset();
      onError?.call(RecordFailure.failed);
      return;
    }
    if (send) {
      if (Duration(milliseconds: wavMs(bytes)) < minLength) {
        _reset();
        hintAsked.value++;
        return;
      }
      return _deliver(bytes);
    }
    wav = bytes;
    wave = waveOf(bytes);
    Microphone.hot.value = false;
    previewId = uuidV4();
    phase = RecordPhase.preview;
    notifyListeners();
  }

  Future<void> _deliver(Uint8List bytes) async {
    final length = Duration(milliseconds: wavMs(bytes));
    final id = previewId;
    _reset();
    if (id.isNotEmpty) unawaited(VoicePlayer.shared.drop(id));
    await onRecorded(bytes, length);
  }

  /// A recording nobody took (the question was dismissed): it waits in the preview to be sent or deleted.
  void restore(Uint8List bytes) {
    if (active) return;
    wav = bytes;
    wave = waveOf(bytes);
    previewId = uuidV4();
    phase = RecordPhase.preview;
    notifyListeners();
  }

  void _reset() {
    _clock?.cancel();
    _clock = null;
    _rec = null;
    _held = false;
    _ending = false;
    phase = RecordPhase.idle;
    elapsed = Duration.zero;
    level = 0;
    drag = Offset.zero;
    wav = null;
    wave = const [];
    previewId = '';
    if (identical(Microphone.owner.value, this)) {
      Microphone.owner.value = null;
      Microphone.hot.value = false;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _clock?.cancel();
    final rec = _rec;
    if (rec != null) unawaited(rec.cancel());
    if (identical(Microphone.owner.value, this)) {
      Microphone.owner.value = null;
      Microphone.hot.value = false;
    }
    hintAsked.dispose();
    super.dispose();
  }
}
