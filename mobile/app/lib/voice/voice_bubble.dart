// What a voice message shows inside a bubble: the play row, and under it the transcript (open until the "Aa" folds
// it), or why there is none yet: "Transcribing…" with a pulsing dot, the error with Retry, or the phone's own
// sending and failed upload.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart' show VoiceError;

import '../l10n/app_localizations.dart';
import '../store/voice_lang.dart';
import '../theme.dart';
import 'player.dart';
import 'voice_view.dart';

/// Where a voice message is: [sending] and [sendFailed] are the phone's own (the upload, the send); the rest is the
/// host's transcription.
enum VoiceStage { transcribing, transcribed, error, sending, sendFailed }

class VoiceBlock extends StatefulWidget {
  const VoiceBlock({
    super.key,
    required this.id,
    required this.ms,
    required this.wave,
    required this.load,
    required this.stage,
    this.error,
    this.onRetry,
    this.onDelete,
    this.transcript,
    this.player,
  });
  final String id;
  final int ms;
  final List<num> wave;
  final LoadVoice load;
  final VoiceStage stage;
  final VoiceError? error;

  /// Retry of a failed transcription or send; null while there is no way to (the window is not there).
  final VoidCallback? onRetry;

  /// Drops a bubble whose send failed.
  final VoidCallback? onDelete;

  /// The transcript, built when it is shown.
  final Widget Function()? transcript;
  final VoicePlayer? player;

  @override
  State<VoiceBlock> createState() => _VoiceBlockState();
}

class _VoiceBlockState extends State<VoiceBlock> {
  // per bubble and local: not stored anywhere
  bool _open = true;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final done = widget.stage == VoiceStage.transcribed;
    final Widget status = switch (widget.stage) {
      VoiceStage.transcribed => const SizedBox.shrink(),
      VoiceStage.transcribing => _Pulse(t.voiceTranscribing),
      VoiceStage.sending => _Pulse(t.voiceSending),
      VoiceStage.error || VoiceStage.sendFailed => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: Text(
              widget.stage == VoiceStage.sendFailed
                  ? t.voiceSendFailed
                  : switch (widget.error) {
                      VoiceError.off => t.dictationHostOff,
                      VoiceError.empty => t.voiceNothing,
                      _ => t.voiceCouldNot,
                    },
              style: TextStyle(color: c.destructive, fontSize: 13),
            ),
          ),
          TextButton(
            onPressed: widget.onRetry,
            style: TextButton.styleFrom(
              visualDensity: VisualDensity.compact,
              foregroundColor: c.accent,
            ),
            child: Text(t.retry),
          ),
          if (widget.onDelete != null)
            TextButton(
              onPressed: widget.onDelete,
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                foregroundColor: c.mutedFg,
              ),
              child: Text(t.voiceDelete),
            ),
        ],
      ),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        VoiceView(
          id: widget.id,
          ms: widget.ms,
          wave: widget.wave,
          load: widget.load,
          player: widget.player,
          trailing: done && widget.transcript != null
              ? Tooltip(
                  message: t.voiceTranscript,
                  child: InkResponse(
                    key: const ValueKey('fold'),
                    onTap: () => setState(() => _open = !_open),
                    radius: 18,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: _open
                            ? c.primary.withValues(alpha: .35)
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        'Aa',
                        style: TextStyle(
                          color: c.mutedFg,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                )
              : null,
        ),
        if (!done)
          Padding(padding: const EdgeInsets.only(top: 4), child: status)
        else if (_open && widget.transcript != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: widget.transcript!(),
          ),
      ],
    );
  }
}

/// A line of muted text with a dot that pulses beside it.
class _Pulse extends StatefulWidget {
  const _Pulse(this.text);
  final String text;

  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final _anim = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        FadeTransition(
          opacity: Tween<double>(begin: .25, end: 1).animate(_anim),
          child: Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
          ),
        ),
        const SizedBox(width: 8),
        Text(widget.text, style: TextStyle(color: c.mutedFg, fontSize: 13)),
      ],
    );
  }
}

/// The language to name on a voice bubble: only under Automatic, when the host's detected [lang] differs from the hint
/// in effect (the app's language). A pin is not a detection, so it never shows one.
String? voiceBadgeLang(BuildContext context, String? lang) {
  final hint = voiceHintOf(context);
  return lang != null && hint != null && lang != hint ? lang : null;
}

/// A small muted code (`FR`) beside the transcript; screen readers get "Recognised as" and its name.
class VoiceLangBadge extends StatelessWidget {
  const VoiceLangBadge(this.lang, {super.key});
  final String lang;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Padding(
      padding: const EdgeInsets.only(left: 6, top: 2),
      child: Semantics(
        label: AppLocalizations.of(
          context,
        ).voiceLangDetected(voiceLangName(lang)),
        excludeSemantics: true,
        child: Text(
          lang.toUpperCase(),
          style: TextStyle(
            color: c.mutedFg,
            fontSize: 11,
            fontFamily: 'monospace',
          ),
        ),
      ),
    );
  }
}
