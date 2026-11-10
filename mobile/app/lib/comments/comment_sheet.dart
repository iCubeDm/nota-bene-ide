// The comment sheet, as the spec sketches it: the quoted selection, the quick labels in a row, a multi-line field.
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../dictation/whisper_sheet.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../store/voice_lang.dart';
import '../voice/player.dart';
import '../voice/record_button.dart';
import '../voice/record_row.dart';
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
/// records voice clips, which the window's Whisper transcribes; without, there is none.
Future<SheetResult?> showCommentSheet(
  BuildContext context, {
  required String quote,
  Comment? editing,
  WindowTab? tab,
}) => showModalBottomSheet<SheetResult>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
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

  @override
  void initState() {
    super.initState();
    _session.addListener(_onSession);
  }

  void _onSession() {
    if (mounted) setState(() {});
  }

  /// What a comment can carry: the desktop's limit.
  static const maxClips = 10;

  @override
  void dispose() {
    _text.dispose();
    _session.removeListener(_onSession);
    _session.dispose();
    super.dispose();
  }

  bool get _busy => _clips.any((c) => c.busy);
  bool get _failed => _clips.any((c) => c.error != null);

  void _recorded(Uint8List wav, Duration length) {
    final c = _Clip.fresh(uuidV4(), wav, voiceLangOf(context));
    setState(() => _clips.add(c));
    _run(c);
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
            onRetry: () => _run(c),
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
    final sheet = Padding(
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
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Stack(
                    children: [
                      // kept while recording: the typed text stays for after
                      Visibility(
                        visible: !_session.active,
                        maintainState: true,
                        maintainSize: true,
                        maintainAnimation: true,
                        child: TextField(
                          controller: _text,
                          autofocus: widget.editing == null,
                          minLines: 2,
                          maxLines: 8,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: InputDecoration(
                            hintText: t.commentHint,
                            border: const OutlineInputBorder(),
                          ),
                        ),
                      ),
                      if (_session.active)
                        Positioned.fill(
                          child: Align(
                            alignment: Alignment.topCenter,
                            child: SizedBox(
                              height: 56,
                              child: RecordRow(session: _session),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                if (widget.tab case final tab? when tab.voiceProtocol)
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    // a context under the sheet's own messenger, so "Whisper is on" shows above the sheet
                    child: Builder(
                      builder: (inner) => RecordButton(
                        session: _session,
                        enabled: _clips.length < maxClips,
                        available: tab.whisper,
                        onUnavailable: () => showWhisperSheet(inner, tab),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                if (widget.editing != null)
                  TextButton(
                    onPressed: () => Navigator.pop(context, SheetDelete()),
                    child: Text(
                      t.deleteComment,
                      style: TextStyle(color: c.destructive),
                    ),
                  ),
                const Spacer(),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: Text(t.cancel),
                ),
                FilledButton(
                  // the text of every clip is part of the comment: Save waits for them
                  onPressed: _busy || _failed || _session.active
                      ? null
                      : () => Navigator.pop(
                          context,
                          SheetSave(_text.text.trim(), _label, [
                            for (final c in _clips)
                              VoiceClip(
                                text: c.text ?? '',
                                id: c.id!,
                                ms: c.ms,
                                wave: c.wave,
                              ),
                          ]),
                        ),
                  child: _busy
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(t.save),
                ),
              ],
            ),
          ],
        ),
      ),
    );
    // The sheet covers the page's Scaffold, so a SnackBar shown there would be hidden under it: the sheet has
    // its own messenger, and an invisible Scaffold of the sheet's size to show it on.
    return ScaffoldMessenger(
      key: _messenger,
      child: Stack(
        children: [
          sheet,
          Positioned.fill(
            child: IgnorePointer(
              child: Scaffold(
                backgroundColor: Colors.transparent,
                resizeToAvoidBottomInset: false,
              ),
            ),
          ),
        ],
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
