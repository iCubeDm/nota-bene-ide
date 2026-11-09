// The round button at the right of the composer: Telegram's hold-to-record. Hold 150 ms and the recording starts; the
// mic grows into a 96 px circle under the finger with a halo that swells with the input level, and a lock floats above
// it. Slide left 96 px to cancel, up 80 px to lock; let go to send. Locked, it is Send, and the lock is Stop. A short
// tap shows the hint. The circle, the lock and the hint are drawn on the overlay, so no parent clips them.
import 'dart:async';

import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'record_session.dart';
import 'recorder.dart';

class RecordButton extends StatefulWidget {
  const RecordButton({
    super.key,
    required this.session,
    this.enabled = true,
    this.available = true,
    this.onUnavailable,
  });
  final RecordSession session;

  /// False while the window is not there to take a message.
  final bool enabled;

  /// False without Whisper on the window: a press then calls [onUnavailable] instead of recording.
  final bool available;
  final VoidCallback? onUnavailable;

  @override
  State<RecordButton> createState() => _RecordButtonState();
}

enum _Press { none, pending, holding }

class _RecordButtonState extends State<RecordButton> {
  static const _holdFor = Duration(milliseconds: 150);
  static const _size = 48.0, _big = 96.0;

  final _link = LayerLink();
  Timer? _holdTimer;
  Timer? _hintTimer;
  OverlayEntry? _held, _lock, _hint;
  _Press _press = _Press.none;
  int? _pointer;
  Offset _origin = Offset.zero;
  late final AppLifecycleListener _lifecycle;

  RecordSession get _s => widget.session;

  @override
  void initState() {
    super.initState();
    _s.addListener(_phaseChanged);
    _s.hintAsked.addListener(_showHint);
    Microphone.owner.addListener(_micChanged);
    // out of sight: a locked recording is kept for the preview rather than recorded into the dark
    _lifecycle = AppLifecycleListener(
      onHide: () {
        if (_s.phase == RecordPhase.locked) _s.stopToPreview();
      },
    );
  }

  @override
  void didUpdateWidget(RecordButton old) {
    super.didUpdateWidget(old);
    if (old.session != widget.session) {
      old.session.removeListener(_phaseChanged);
      old.session.hintAsked.removeListener(_showHint);
      widget.session.addListener(_phaseChanged);
      widget.session.hintAsked.addListener(_showHint);
    }
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _s.removeListener(_phaseChanged);
    _s.hintAsked.removeListener(_showHint);
    Microphone.owner.removeListener(_micChanged);
    _holdTimer?.cancel();
    _hintTimer?.cancel();
    _held?.remove();
    _lock?.remove();
    _hint?.remove();
    super.dispose();
  }

  void _micChanged() {
    if (mounted) setState(() {});
  }

  /// The one recorder is another button's.
  bool get _elsewhere =>
      Microphone.owner.value != null && !identical(Microphone.owner.value, _s);

  void _phaseChanged() {
    final p = _s.phase;
    if (p == RecordPhase.recording && _held == null) {
      _held = OverlayEntry(
        builder: (_) => _HeldOverlay(link: _link, session: _s),
      );
      _lock = OverlayEntry(
        builder: (_) => _LockOverlay(link: _link, session: _s),
      );
      Overlay.of(context).insertAll([_held!, _lock!]);
    }
    // the circle goes once the finger does; the lock stays as Stop while locked
    if (p != RecordPhase.recording && _held != null) {
      _held!.remove();
      _held = null;
    }
    if ((p == RecordPhase.idle || p == RecordPhase.preview) && _lock != null) {
      _lock!.remove();
      _lock = null;
    }
    if (mounted) setState(() {});
  }

  void _showHint() {
    if (!mounted) return;
    _hintTimer?.cancel();
    _hint?.remove();
    final entry = _hint = OverlayEntry(builder: (_) => _Hint(link: _link));
    Overlay.of(context).insert(entry);
    _hintTimer = Timer(const Duration(seconds: 2), () {
      if (identical(_hint, entry)) _hint = null;
      entry.remove();
    });
  }

  void _down(PointerDownEvent e) {
    if (!widget.enabled || _elsewhere || _pointer != null || _s.active) return;
    if (!widget.available) {
      widget.onUnavailable?.call();
      return;
    }
    _pointer = e.pointer;
    _origin = e.position;
    _press = _Press.pending;
    _holdTimer = Timer(_holdFor, () {
      _press = _Press.holding;
      _s.begin();
    });
  }

  void _move(PointerMoveEvent e) {
    if (e.pointer != _pointer || _press != _Press.holding) return;
    _s.moveBy(e.position - _origin);
  }

  void _up(PointerEvent e) {
    if (e.pointer != _pointer) return;
    _pointer = null;
    final was = _press;
    _press = _Press.none;
    _holdTimer?.cancel();
    if (was == _Press.pending) {
      if (e is PointerUpEvent) _s.hintAsked.value++;
    } else if (was == _Press.holding) {
      if (e is PointerUpEvent) {
        _s.release();
      } else {
        _s.cancel();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final sending =
        _s.phase == RecordPhase.locked || _s.phase == RecordPhase.preview;
    final on = widget.enabled && !_elsewhere;
    final button = Container(
      width: _size,
      height: _size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: on ? c.primary : c.muted,
        shape: BoxShape.circle,
      ),
      child: NbIcon(
        sending ? NbGlyph.send : NbGlyph.mic,
        color: on ? c.primaryFg : c.mutedFg,
      ),
    );
    return CompositedTransformTarget(
      link: _link,
      child: sending
          ? Tooltip(
              message: t.send,
              child: GestureDetector(
                key: const ValueKey('voice-send'),
                onTap: _s.send,
                child: button,
              ),
            )
          : Listener(
              behavior: HitTestBehavior.opaque,
              onPointerDown: _down,
              onPointerMove: _move,
              onPointerUp: _up,
              onPointerCancel: _up,
              // a finger on the mic must not turn into a drag of a sheet or a list behind it
              child: GestureDetector(
                onPanUpdate: (_) {},
                child: Semantics(
                  button: true,
                  enabled: on,
                  label: t.voiceHold,
                  // TalkBack cannot hold: a tap starts a locked recording
                  onTap: on && widget.available
                      ? () => _s.beginLocked()
                      : widget.onUnavailable,
                  child: ExcludeSemantics(child: button),
                ),
              ),
            ),
    );
  }
}

/// The big circle with its halo, following the finger.
class _HeldOverlay extends StatelessWidget {
  const _HeldOverlay({required this.link, required this.session});
  final LayerLink link;
  final RecordSession session;

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: ListenableBuilder(
      listenable: session,
      builder: (context, _) {
        final c = Theme.of(context).extension<NbColors>()!;
        final halo = _RecordButtonState._big + 36 * session.level.clamp(0, 1);
        return CompositedTransformFollower(
          link: link,
          showWhenUnlinked: false,
          targetAnchor: Alignment.center,
          followerAnchor: Alignment.center,
          offset: session.drag,
          child: Stack(
            alignment: Alignment.center,
            clipBehavior: Clip.none,
            children: [
              AnimatedContainer(
                duration: const Duration(milliseconds: 100),
                width: halo,
                height: halo,
                decoration: BoxDecoration(
                  color: c.primary.withValues(alpha: .25),
                  shape: BoxShape.circle,
                ),
              ),
              Container(
                width: _RecordButtonState._big,
                height: _RecordButtonState._big,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: c.primary,
                  shape: BoxShape.circle,
                ),
                child: NbIcon(NbGlyph.mic, size: 32, color: c.primaryFg),
              ),
            ],
          ),
        );
      },
    ),
  );
}

/// The lock above the button: a lock over a chevron that closes as the finger rises; once locked, Stop.
class _LockOverlay extends StatelessWidget {
  const _LockOverlay({required this.link, required this.session});
  final LayerLink link;
  final RecordSession session;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: session,
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final locked = session.phase == RecordPhase.locked;
      final p = (-session.drag.dy / RecordSession.lockAt).clamp(0.0, 1.0);
      // above the 96 px circle while held, just above the (48 px) button once locked
      final gap = locked ? 8.0 : _RecordButtonState._big / 2 + 12;
      return CompositedTransformFollower(
        link: link,
        showWhenUnlinked: false,
        targetAnchor: Alignment.center,
        followerAnchor: Alignment.bottomCenter,
        offset: Offset(0, -(locked ? 24.0 : 0) - gap),
        child: locked
            ? Tooltip(
                message: t.voiceStop,
                child: GestureDetector(
                  key: const ValueKey('voice-stop'),
                  onTap: session.stopToPreview,
                  child: Container(
                    width: 40,
                    height: 40,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: c.popover,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: c.border),
                    ),
                    child: NbIcon(NbGlyph.stop, color: c.destructive),
                  ),
                ),
              )
            : IgnorePointer(
                child: Container(
                  width: 40,
                  height: 76 - 36 * p,
                  decoration: BoxDecoration(
                    color: c.popover,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: c.border),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      NbIcon(NbGlyph.lock, size: 18, color: c.foreground),
                      if (p < .6)
                        Opacity(
                          opacity: 1 - p / .6,
                          child: NbIcon(
                            NbGlyph.chevronUp,
                            size: 16,
                            color: c.mutedFg,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
      );
    },
  );
}

/// Telegram's hint of a short tap: a small dark tooltip over the button, gone after 2 s.
class _Hint extends StatefulWidget {
  const _Hint({required this.link});
  final LayerLink link;

  @override
  State<_Hint> createState() => _HintState();
}

class _HintState extends State<_Hint> {
  bool _on = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _on = true);
    });
    Timer(const Duration(milliseconds: 1700), () {
      if (mounted) setState(() => _on = false);
    });
  }

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: CompositedTransformFollower(
      link: widget.link,
      showWhenUnlinked: false,
      targetAnchor: Alignment.topRight,
      followerAnchor: Alignment.bottomRight,
      offset: const Offset(0, -8),
      child: AnimatedOpacity(
        opacity: _on ? 1 : 0,
        duration: const Duration(milliseconds: 200),
        child: Container(
          constraints: const BoxConstraints(maxWidth: 240),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: const Color(0xE6212121),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            AppLocalizations.of(context).voiceHint,
            style: const TextStyle(color: Color(0xFFFFFFFF), fontSize: 13),
          ),
        ),
      ),
    ),
  );
}
