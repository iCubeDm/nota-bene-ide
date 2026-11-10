// The comment sheet: the quoted selection, the quick labels in a row, the clips the comment has, and the chat's message
// field. Send saves; a recording released in the field saves the comment with that voice as soon as its text is in.
import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/message_field.dart';
import '../chat/window_tab.dart';
import '../dictation/whisper_sheet.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../store/voice_lang.dart';
import '../voice/player.dart';
import '../voice/record_session.dart';
import '../voice/recorder.dart';
import '../voice/upload.dart';
import '../voice/voice_bubble.dart';
import '../voice/wav.dart';
import 'strings.g.dart';

/// What the sheet gave: a comment to save, or the edited one deleted.
sealed class SheetResult {}

class SheetSave extends SheetResult {
  SheetSave(this.text, this.label, [this.voice = const []]);
  final String text;
  final QuickLabelId? label;

  /// The voice clips, each with its transcript, in order.
  final List<VoiceClip> voice;
}

class SheetDelete extends SheetResult {}

/// Null when dismissed. With [editing], the fields start from it and Delete is offered. With the [tab], the mic
/// records a voice clip, which the window's Whisper transcribes; without, there is none.
Future<SheetResult?> showCommentSheet(
  BuildContext context, {
  required String quote,
  Comment? editing,
  WindowTab? tab,
}) => showModalBottomSheet<SheetResult>(
  context: context,
  isScrollControlled: true,
  // the sheet draws its own handle and closes by a swipe on it, so that a draft is asked about first
  enableDrag: false,
  backgroundColor: Colors.transparent,
  elevation: 0,
  builder: (_) => _Sheet(quote: quote, editing: editing, tab: tab),
);

class _Sheet extends StatefulWidget {
  const _Sheet({required this.quote, this.editing, this.tab});
  final String quote;
  final Comment? editing;
  final WindowTab? tab;

  @override
  State<_Sheet> createState() => _SheetState();
}

class _SheetState extends State<_Sheet> {
  late final _text = TextEditingController(text: widget.editing?.text ?? '');
  late QuickLabelId? _label = widget.editing?.label;
  late final _clips = [
    for (final v in widget.editing?.voice ?? const <VoiceClip>[]) _Clip.done(v),
  ];
  late final _session = RecordSession(
    onRecorded: _recorded,
    onError: _recordFailed,
  );
  final _messenger = GlobalKey<ScaffoldMessengerState>();
  final _overlay = GlobalKey();
  double _drag = 0;
  bool _dragging = false;
  late final _focus = FocusNode();
  late final _initialText = (widget.editing?.text ?? '').trim();
  late final _initialClips = [for (final c in _clips) c.key];

  @override
  void initState() {
    super.initState();
    _session.addListener(_onSession);
    _text.addListener(_onSession);
  }

  void _onSession() {
    if (mounted) setState(() {});
  }

  /// What a comment can carry: the desktop's limit.
  static const maxClips = 10;

  @override
  void dispose() {
    _text.removeListener(_onSession);
    _text.dispose();
    _focus.dispose();
    _session.removeListener(_onSession);
    _session.dispose();
    super.dispose();
  }

  bool get _busy => _clips.any((c) => c.busy);
  bool get _failed => _clips.any((c) => c.error != null);

  void _recorded(Uint8List wav, Duration length) {
    final c = _Clip.fresh(uuidV4(), wav, voiceLangOf(context));
    setState(() => _clips.add(c));
    unawaited(_attempt(c));
  }

  /// A fresh recording: its text is asked for, and once it is in, the comment is saved with it.
  Future<void> _attempt(_Clip c) async {
    await _run(c);
    if (mounted &&
        _clips.contains(c) &&
        !_busy &&
        !_failed &&
        c.error == null) {
      _save();
    }
  }

  void _save() => Navigator.pop(
    context,
    SheetSave(_text.text.trim(), _label, [
      for (final c in _clips)
        VoiceClip(text: c.text ?? '', id: c.id!, ms: c.ms, wave: c.wave),
    ]),
  );

  /// There is something here that closing would lose: typed text, a clip removed or a new one on its way.
  bool get _dirty =>
      _text.text.trim() != _initialText ||
      (widget.editing != null && _label != widget.editing!.label) ||
      !listEquals([for (final c in _clips) c.key], _initialClips);

  /// Back and a swipe down: a recording stops into the preview and the user chooses; a draft is asked about.
  Future<void> _leave() async {
    if (_session.phase == RecordPhase.recording && _session.holding) return;
    final t = AppLocalizations.of(context);
    final nav = Navigator.of(context);
    if (_session.active) {
      await _session.stopToPreview();
      if (!mounted || _session.phase != RecordPhase.preview) return;
      final choice = await showDialog<String>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(t.voiceLeaveTitle),
          content: Text(t.voiceLeaveBody),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c),
              child: Text(t.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c, 'delete'),
              child: Text(t.voiceDelete),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(c, 'send'),
              child: Text(t.send),
            ),
          ],
        ),
      );
      if (choice == null || !mounted) return;
      if (choice == 'send') {
        // saved by its text, as a released one is (the sheet closes then); the busy question does not exist here
        await _session.send();
        return;
      }
      _session.cancel();
    }
    if (!_dirty) {
      nav.pop();
      return;
    }
    final drop = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(t.commentDiscardTitle),
        content: Text(t.commentDiscardBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: Text(t.commentKeep),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: Text(t.commentDiscard),
          ),
        ],
      ),
    );
    if (drop == true && mounted) nav.pop();
  }

  void _recordFailed(RecordFailure why) {
    final t = AppLocalizations.of(context);
    _messenger.currentState?.showSnackBar(
      SnackBar(
        content: Text(
          why == RecordFailure.denied ? t.dictationDenied : t.voiceRecordFailed,
        ),
      ),
    );
  }

  /// Uploads the clip when the host has not got it, then asks for its text; a failure stays on the clip with Retry.
  Future<void> _run(_Clip c) async {
    final tab = widget.tab;
    final lang = c.lang ??= voiceLangOf(context);
    setState(() {
      c.busy = true;
      c.error = null;
    });
    final http = tab?.http;
    if (http == null) return _done(c, error: VoiceError.failed);
    if (c.id == null) {
      try {
        final v = await uploadVoice(http, c.wav!);
        c.id = v.id;
        // cached under the host's id: playing it needs no download
        unawaited(
          VoicePlayer.shared.files
              .save(v.id, c.wav!)
              .then<void>((_) {})
              .catchError((Object _) {}),
        );
        c.wave = v.wave;
        c.ms = v.ms.toInt();
      } on VoiceUploadError {
        return _done(c, error: VoiceError.failed);
      }
    }
    final r = await transcribeClip(http, c.id!, lang);
    if (r.error == VoiceError.off) tab!.whisperOn = false;
    _done(c, text: r.text, error: r.error);
  }

  void _done(_Clip c, {String? text, VoiceError? error}) {
    if (!mounted || !_clips.contains(c)) return;
    setState(() {
      c.busy = false;
      c.text = text;
      c.error = error;
    });
  }

  Widget _clipRow(
    WindowTab? tab,
    _Clip c,
    AppLocalizations t,
    NbColors col,
  ) => Row(
    key: ValueKey(c.key),
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(
        child: Align(
          alignment: Alignment.centerLeft,
          child: VoiceBlock(
            id: c.id ?? c.key,
            ms: c.ms,
            wave: c.wave,
            load: c.wav != null ? () async => c.wav : voiceLoader(tab, c.id!),
            stage: c.busy
                ? VoiceStage.transcribing
                : (c.error != null ? VoiceStage.error : VoiceStage.transcribed),
            error: c.error,
            onRetry: () => c.wav != null ? _attempt(c) : _run(c),
            transcript: () => Text(c.text ?? ''),
          ),
        ),
      ),
      IconButton(
        tooltip: t.voiceDelete,
        icon: NbIcon(NbGlyph.trash, color: col.mutedFg),
        onPressed: () {
          setState(() => _clips.remove(c));
          if (c.wav != null) {
            unawaited(VoicePlayer.shared.drop(c.key));
            if (c.id != null) unawaited(VoicePlayer.shared.drop(c.id!));
          }
        },
      ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final inner = Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        0,
        16,
        16 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      // ten clips do not fit a short screen: the sheet scrolls
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // a swipe down closes (after asking about a draft); the sheet follows the finger and springs back
            Semantics(
              button: true,
              label: MaterialLocalizations.of(context).modalBarrierDismissLabel,
              onTap: () => unawaited(Navigator.of(context).maybePop()),
              child: GestureDetector(
                key: const ValueKey('sheet-handle'),
                behavior: HitTestBehavior.opaque,
                onVerticalDragStart: (_) => setState(() => _dragging = true),
                onVerticalDragUpdate: (d) =>
                    setState(() => _drag = math.max(0, _drag + d.delta.dy)),
                onVerticalDragEnd: (d) async {
                  final close = _drag > 96 || (d.primaryVelocity ?? 0) > 700;
                  setState(() => _dragging = false);
                  if (close) {
                    final popped = await Navigator.of(context).maybePop();
                    if (popped) return;
                  }
                  if (mounted) setState(() => _drag = 0);
                },
                onVerticalDragCancel: () => setState(() {
                  _dragging = false;
                  _drag = 0;
                }),
                child: Center(
                  child: Container(
                    width: 32,
                    height: 4,
                    margin: const EdgeInsets.symmetric(vertical: 14),
                    decoration: BoxDecoration(
                      color: c.mutedFg.withValues(alpha: .4),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              ),
            ),
            Container(
              padding: const EdgeInsets.only(left: 10),
              decoration: BoxDecoration(
                border: Border(left: BorderSide(color: c.accent, width: 3)),
              ),
              child: Text(
                widget.quote,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: c.mutedFg),
              ),
            ),
            const SizedBox(height: 12),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final l in quickLabels)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      // the name is the tooltip (a long press), as on the message menu's labels
                      child: Tooltip(
                        message: l.textIn(lang),
                        child: GestureDetector(
                          onTap: () => setState(
                            () => _label = _label == l.id ? null : l.id,
                          ),
                          child: Container(
                            key: ValueKey('label:${l.id.name}'),
                            width: 32,
                            height: 32,
                            alignment: Alignment.center,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: c.muted,
                              border: Border.all(
                                color: _label == l.id
                                    ? c.accent
                                    : Colors.transparent,
                                width: 2,
                              ),
                            ),
                            child: Text(
                              l.emoji,
                              style: const TextStyle(fontSize: 16, height: 1),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            for (final clip in _clips) _clipRow(widget.tab, clip, t, c),
            const SizedBox(height: 12),
            _field(t, c),
            if (widget.editing != null)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: () => Navigator.pop(context, SheetDelete()),
                  child: Text(
                    t.deleteComment,
                    style: TextStyle(color: c.destructive),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
    final theme = Theme.of(context);
    final sheet = TweenAnimationBuilder<double>(
      tween: Tween(end: _drag),
      duration: _dragging ? Duration.zero : const Duration(milliseconds: 150),
      builder: (_, dy, child) =>
          Transform.translate(offset: Offset(0, dy), child: child),
      child: Material(
        color:
            theme.bottomSheetTheme.backgroundColor ??
            theme.colorScheme.surfaceContainerLow,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        ),
        clipBehavior: Clip.antiAlias,
        child: inner,
      ),
    );
    // The sheet covers the page's Scaffold, so a SnackBar shown there would be hidden under it: the sheet has
    // its own messenger, and an invisible Scaffold of the sheet's size to show it on.
    return PopScope(
      // a recording or a draft is never dropped by a back press: it is asked about
      canPop: !_session.active && !_dirty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_leave());
      },
      child: ScaffoldMessenger(
        key: _messenger,
        child: Stack(
          children: [
            sheet,
            Positioned.fill(
              child: IgnorePointer(
                child: Scaffold(
                  key: _overlay,
                  backgroundColor: Colors.transparent,
                  resizeToAvoidBottomInset: false,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The chat's message field; the mic stays beside Send while there is no text, so that a label (or the clips an edit
  /// has) can go with a voice. A recording that is under way, or a clip waiting for its text, holds Send.
  Widget _field(AppLocalizations t, NbColors c) {
    final tab = widget.tab;
    final typed = _text.text.trim().isNotEmpty;
    final sendable = typed || _label != null || _clips.isNotEmpty;
    final voice = tab != null;
    return Builder(
      // a context under the sheet's own messenger, so "Whisper is on" shows above the sheet
      builder: (inner) => MessageField(
        controller: _text,
        focus: _focus,
        autofocus: widget.editing == null,
        hint: t.commentHint,
        maxLines: 8,
        session: _session,
        open: true,
        voiceProtocol: tab?.voiceProtocol ?? false,
        whisperAvailable: tab?.whisper ?? false,
        onWhisperMissing: () => showWhisperSheet(inner, tab!),
        micEnabled: _clips.length < maxClips && !_busy && !_failed,
        showMic: voice && !typed,
        // kept while recording, so that the mic does not move under the finger
        showSend: sendable,
        canSend: sendable && !_busy && !_failed && !_session.active,
        sending: _busy,
        onSend: _save,
        snackScaffold: () => _overlay.currentContext,
      ),
    );
  }
}

/// One clip of the sheet: a fresh recording on its way to the host and its text, or one the comment already has.
class _Clip {
  _Clip.fresh(this.key, Uint8List this.wav, this.lang)
    : ms = wavMs(wav),
      wave = waveOf(wav),
      busy = true;
  _Clip.done(VoiceClip v)
    : key = v.id,
      id = v.id,
      ms = v.ms.toInt(),
      wave = v.wave,
      text = v.text,
      busy = false;

  final String key;

  /// The language it was recorded in; a Retry asks for the text in it, whatever Settings say by then.
  String? lang;
  Uint8List? wav;
  String? id;
  int ms;
  List<num> wave;
  String? text;
  VoiceError? error;
  bool busy;
}
