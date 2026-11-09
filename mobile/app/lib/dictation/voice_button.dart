// The voice control of a text field: hold to record, slide left to cancel, slide up to lock. The phone records, the
// window's Whisper transcribes, and the words land at the cursor captured at the start.
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'dictation.dart';

enum VoiceState { idle, recording, locked, working }

/// What the record bar shows of a session: the input levels and the time elapsed.
class VoiceMeter extends ChangeNotifier {
  static const keep = 40;
  List<double> levels = const [];
  Duration elapsed = Duration.zero;

  // which part of a long recording is being transcribed, of how many; 0 while there are no parts
  int part = 0, parts = 0;

  void add(double v) {
    levels = [...levels.skip(levels.length >= keep ? 1 : 0), v.clamp(0, 1)];
    notifyListeners();
  }

  void tick() {
    elapsed += const Duration(seconds: 1);
    notifyListeners();
  }

  void progress(int part, int parts) {
    this.part = part;
    this.parts = parts;
    notifyListeners();
  }

  void reset() {
    levels = const [];
    elapsed = Duration.zero;
    part = parts = 0;
    notifyListeners();
  }
}

class VoiceButton extends StatefulWidget {
  const VoiceButton({
    super.key,
    required this.controller,
    this.enabled = true,
    required this.chooser,
    this.onUnavailable,
    this.onState,
    this.meter,
  });
  final TextEditingController controller;
  final bool enabled;

  /// Picks the dictation for a session; null while there is none to record with.
  final Dictation? Function() chooser;

  /// Called instead of recording when [chooser] has none, on a tap or a hold.
  final VoidCallback? onUnavailable;

  /// Told of each change of state, so the host can swap its field for the record bar.
  final ValueChanged<VoiceState>? onState;

  /// Fed with the levels and the time, for the record bar; the button keeps its own when none is given.
  final VoiceMeter? meter;

  /// Ends the dictation in progress, if any, before its field is read.
  static void cancelRunning() => _VoiceButtonState._current?._cancel();

  /// Stops the dictation in progress, if any, and completes when its final result is in the field, so the field
  /// can be read; nothing recorded is lost (the transcription has its own timeout).
  static Future<void> finishRunning() async =>
      _VoiceButtonState._current?._finish();

  /// Stops the locked recording in progress, if any, and transcribes it.
  static void stopRunning() => _VoiceButtonState._current?._stop();

  @override
  State<VoiceButton> createState() => _VoiceButtonState();
}

enum _Gesture { none, pending, holding, done }

class _VoiceButtonState extends State<VoiceButton> {
  // only one voice records at a time: starting another cancels this one
  static _VoiceButtonState? _current;
  static const _holdFor = Duration(milliseconds: 200);
  static const _cancelAt = 96.0;
  static const _lockAt = 80.0;

  StreamSubscription<DictationEvent>? _sub;
  late final AppLifecycleListener _lifecycle;
  late final _own = VoiceMeter();
  VoiceMeter get _meter => widget.meter ?? _own;
  Timer? _holdTimer;
  Timer? _clock;
  _Gesture _g = _Gesture.none;
  int? _pointer;
  Offset _origin = Offset.zero;
  VoiceState _vs = VoiceState.idle;
  // the field as it was at the start, and as this button last wrote it
  TextEditingValue _saved = TextEditingValue.empty;
  TextEditingValue? _written;
  String _before = '';
  String _after = '';
  // what this button wrote between _before and _after (separators included)
  String _ins = '';
  bool _stopping = false;
  Completer<void>? _ended;
  Dictation? _active;
  // picked on the press, used when the hold starts
  Dictation? _next;
  bool get _listening => _sub != null;

  @override
  void initState() {
    super.initState();
    // onHide, not onInactive: the permission dialog and a notification shade only make the app inactive,
    // while onHide means the app is really out of sight.
    _lifecycle = AppLifecycleListener(
      onHide: () {
        if (_listening) _cancel();
      },
    );
  }

  @override
  void didUpdateWidget(VoiceButton old) {
    super.didUpdateWidget(old);
    if (!widget.enabled && _listening) {
      // the host went away under a recording or a post: say so
      _end(cancel: true, deferred: true);
      // not during build: a snack bar cannot be shown from here
      final messenger = ScaffoldMessenger.of(context);
      final text = AppLocalizations.of(context).dictationHostFailed;
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => messenger.showSnackBar(SnackBar(content: Text(text))),
      );
    }
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _holdTimer?.cancel();
    if (_listening) _end(cancel: true, rebuild: false);
    super.dispose();
  }

  // the platform call is not awaited; its failure must not become an unhandled error
  static void _fire(Future<void> call) => unawaited(call.catchError((_) {}));

  void _set(VoiceState s, {bool deferred = false}) {
    if (_vs == s) return;
    _vs = s;
    final cb = widget.onState;
    if (cb != null) {
      if (deferred) {
        WidgetsBinding.instance.addPostFrameCallback((_) => cb(s));
      } else {
        cb(s);
      }
    }
  }

  void _end({
    required bool cancel,
    bool rebuild = true,
    bool restore = false,
    bool deferred = false,
  }) {
    _sub?.cancel();
    _sub = null;
    _clock?.cancel();
    _clock = null;
    _stopping = false;
    final ended = _ended;
    _ended = null;
    if (ended != null && !ended.isCompleted) ended.complete();
    // the field goes back to what it was, unless the user has typed since
    if (restore && widget.controller.value == _written) {
      widget.controller.value = _saved;
    }
    _written = null;
    if (identical(_current, this)) _current = null;
    final active = _active;
    if (cancel && active != null) _fire(active.cancel());
    if (rebuild && mounted) {
      _set(VoiceState.idle, deferred: deferred);
      setState(() {});
    }
  }

  // cancelled by the user: nothing is inserted
  void _cancel() => _end(cancel: true, restore: true);

  // stop, then wait for the end of the session
  Future<void> _finish() {
    if (!_listening) return Future.value();
    final done = (_ended ??= Completer<void>()).future;
    _stop();
    return done;
  }

  void _start(Dictation d) {
    _current?._end(cancel: true, restore: true);
    final value = widget.controller.value;
    final text = value.text;
    final sel = value.selection;
    final at = sel.isValid ? sel : TextSelection.collapsed(offset: text.length);
    _saved = value;
    _written = value;
    _before = at.textBefore(text);
    _after = at.textAfter(text);
    _ins = '';
    // Whisper speaks the UI's language, not the device's
    final lang = Localizations.localeOf(context).languageCode;
    _stopping = false;
    _current = this;
    _meter.reset();
    _active = d;
    _clock?.cancel();
    _clock = Timer.periodic(const Duration(seconds: 1), (_) => _meter.tick());
    _sub = d.listen(lang).listen(_on);
    _set(VoiceState.recording);
    setState(() {});
  }

  // one stop per session: a second one could lose the result
  void _stop() {
    if (!_listening || _stopping) return;
    _stopping = true;
    _fire(_active!.stop());
    _set(VoiceState.working);
    setState(() {});
  }

  void _put(String words) {
    final cur = widget.controller.value;
    var rest = _after;
    var oldEnd = _before.length + _ins.length;
    if (cur != _written) {
      // typed while the host transcribed: the words go where the recording began, around what was typed
      if (!cur.text.startsWith('$_before$_ins')) return;
      rest = cur.text.substring(oldEnd);
    }
    final sep = _before.isNotEmpty && !RegExp(r'\s$').hasMatch(_before)
        ? ' '
        : '';
    final gap = rest.isNotEmpty && !RegExp(r'^\s').hasMatch(rest) ? ' ' : '';
    final ins = '$sep$words$gap';
    final head = '$_before$sep$words';
    int shift(int o) => o >= oldEnd ? o + ins.length - _ins.length : o;
    final typed = cur != _written && cur.selection.isValid;
    final value = TextEditingValue(
      text: '$_before$ins$rest',
      selection: typed
          ? TextSelection(
              baseOffset: shift(cur.selection.baseOffset),
              extentOffset: shift(cur.selection.extentOffset),
            )
          : TextSelection.collapsed(offset: head.length),
    );
    _ins = ins;
    _written = widget.controller.value = value;
  }

  void _on(DictationEvent e) {
    if (e is DictationLevel) {
      _meter.add(e.value);
      return;
    }
    final typed = widget.controller.value != _written;
    if (e is! DictationEnd && typed && !_stopping) {
      // the user typed or moved the cursor: their field wins and the dictation is over
      _end(cancel: true);
      return;
    }
    switch (e) {
      case DictationLevel():
        break;
      case DictationWorking(:final part, :final parts):
        // the recording is over, also when the recorder's cap ended it: typing from now on keeps the session
        _stopping = true;
        _meter.progress(part, parts);
        _set(VoiceState.working);
        setState(() {});
      case DictationFinal(:final text):
        if (text.isNotEmpty) _put(text);
      case DictationError(:final why):
        // the parts of a long recording transcribed before a failure stay
        if (!typed && _ins.isEmpty) widget.controller.value = _saved;
        // Whisper went off on the computer since the hello: the sheet that turns it back on opens too
        if (why == DictationFailure.hostOff) widget.onUnavailable?.call();
        final t = AppLocalizations.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(switch (why) {
              DictationFailure.denied => t.dictationDenied,
              DictationFailure.noMatch => t.dictationNoMatch,
              DictationFailure.failed => t.dictationFailed,
              DictationFailure.hostFailed => t.dictationHostFailed,
              DictationFailure.hostOff => t.dictationHostOff,
              DictationFailure.cut => t.dictationCut,
            }),
          ),
        );
      case DictationEnd():
        _end(cancel: false);
    }
  }

  void _down(PointerDownEvent e) {
    if (!widget.enabled || _pointer != null || _vs != VoiceState.idle) return;
    final d = _next = widget.chooser();
    if (d == null) {
      widget.onUnavailable?.call();
      return;
    }
    _pointer = e.pointer;
    _origin = e.position;
    _g = _Gesture.pending;
    _holdTimer = Timer(_holdFor, () {
      _g = _Gesture.holding;
      HapticFeedback.lightImpact();
      _start(_next!);
    });
  }

  void _move(PointerMoveEvent e) {
    if (e.pointer != _pointer || _g != _Gesture.holding) return;
    final d = e.position - _origin;
    if (d.dx <= -_cancelAt) {
      _g = _Gesture.done;
      HapticFeedback.mediumImpact();
      _cancel();
    } else if (-d.dy >= _lockAt) {
      _g = _Gesture.done;
      HapticFeedback.mediumImpact();
      _set(VoiceState.locked);
      setState(() {});
    }
  }

  void _up(PointerEvent e) {
    if (e.pointer != _pointer) return;
    _pointer = null;
    final g = _g;
    _g = _Gesture.none;
    _holdTimer?.cancel();
    if (g == _Gesture.pending) {
      if (e is PointerUpEvent) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(AppLocalizations.of(context).voiceHold)),
        );
      }
    } else if (g == _Gesture.holding) {
      if (e is PointerUpEvent) {
        _stop();
      } else {
        _cancel();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final Widget icon = switch (_vs) {
      VoiceState.idle => NbIcon(
        NbGlyph.mic,
        color: widget.enabled ? null : c.mutedFg,
      ),
      VoiceState.recording => Container(
        width: 40,
        height: 40,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
        child: NbIcon(NbGlyph.mic, color: c.background),
      ),
      // the record bar carries the controls now; this stays only to keep the session
      VoiceState.locked || VoiceState.working => const SizedBox.shrink(),
    };
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: _down,
      onPointerMove: _move,
      onPointerUp: _up,
      onPointerCancel: _up,
      child: Semantics(
        button: true,
        enabled: widget.enabled,
        label: t.voiceHold,
        child: _vs == VoiceState.locked || _vs == VoiceState.working
            ? const SizedBox.shrink()
            : SizedBox.square(dimension: 48, child: Center(child: icon)),
      ),
    );
  }
}
