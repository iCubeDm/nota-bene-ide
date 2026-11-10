// The message field, shared by the chat and the comment sheet: one rounded field with the text, then the paperclip (when
// the page has one, and only while there is no text) and at the right the mic, which becomes Send once there is something
// to send. A recording takes the text's place. The page decides what is sent and what a recording does; this only draws
// and routes the taps, so both fields have the same geometry and the same states.
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../voice/record_button.dart';
import '../voice/record_row.dart';
import '../voice/record_session.dart';

/// The mic, Send and the paperclip inside the field.
const _button = 40.0;

/// The space around the action button (and between it and the paperclip: 8 beside it, the paperclip's own).
const _inset = 3.0;

class MessageField extends StatefulWidget {
  const MessageField({
    super.key,
    required this.controller,
    required this.hint,
    required this.session,
    required this.open,
    required this.voiceProtocol,
    required this.whisperAvailable,
    required this.onWhisperMissing,
    required this.showMic,
    required this.showSend,
    required this.canSend,
    required this.onSend,
    this.focus,
    this.autofocus = false,
    this.maxLines = 6,
    this.sending = false,
    this.micEnabled,
    this.onAttach,
    this.floating,
    this.snackAnchor,
  });

  final TextEditingController controller;
  final FocusNode? focus;
  final String hint;
  final bool autofocus;
  final int maxLines;
  final RecordSession session;

  /// The page can take input now (the window is open); the mic and the paperclip are off otherwise.
  final bool open;

  /// A window older than protocol 14 has no voice: its mic is greyed and says why on a tap, not missing.
  final bool voiceProtocol;
  final bool whisperAvailable;
  final VoidCallback onWhisperMissing;

  /// Whether the mic is on (it is [open] by default; the comment sheet turns it off at its clip limit).
  final bool? micEnabled;

  /// The mic and Send, either or both (the comment sheet keeps the mic beside Send while a label waits for a voice).
  final bool showMic, showSend;
  final bool canSend;

  /// A upload in progress: Send shows a spinner.
  final bool sending;
  final VoidCallback onSend;

  /// The paperclip; null when the page has none.
  final VoidCallback? onAttach;

  /// Something floating over the right button (the chat's Stop), given the link to it.
  final Widget Function(LayerLink link)? floating;

  /// The box a snackbar of the greyed mic floats above (the page's own by default).
  final BuildContext Function()? snackAnchor;

  @override
  State<MessageField> createState() => _MessageFieldState();
}

class _MessageFieldState extends State<MessageField> {
  final _trailing = LayerLink();

  /// The old host's mic says why it does nothing: a snackbar floating above the message field, not over it.
  void _micOldSnack(String text) {
    final ctx = context;
    final messenger = ScaffoldMessenger.maybeOf(ctx);
    final scaffold = Scaffold.maybeOf(ctx)?.context.findRenderObject();
    final box = (widget.snackAnchor?.call() ?? ctx).findRenderObject();
    var bottom = 8.0;
    if (messenger == null) return;
    if (scaffold is RenderBox && box is RenderBox && box.hasSize) {
      final end = scaffold.localToGlobal(Offset.zero).dy + scaffold.size.height;
      bottom = math.max(8, end - box.localToGlobal(Offset.zero).dy + 8);
    }
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(
        content: Text(text),
        behavior: SnackBarBehavior.floating,
        margin: EdgeInsets.fromLTRB(8, 0, 8, bottom),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.controller, widget.session]),
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final recording = widget.session.active;
      final typed = widget.controller.text.isNotEmpty;
      final open = widget.open;
      final field = TextField(
        controller: widget.controller,
        focusNode: widget.focus,
        autofocus: widget.autofocus,
        // a draft is written also while the window is away; only the send waits for it
        minLines: 1,
        maxLines: widget.maxLines,
        textCapitalization: TextCapitalization.sentences,
        decoration: InputDecoration(
          hintText: widget.hint,
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          disabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          isDense: true,
          contentPadding: const EdgeInsets.fromLTRB(16, 8, 4, 8),
        ),
      );
      final showMic = widget.showMic && !widget.showSend;
      // the mic: a window older than protocol 14 gets the greyed one
      final Widget mic = !widget.voiceProtocol
          ? IconButton(
              key: const ValueKey('mic-old'),
              tooltip: t.micUnavailable,
              icon: const NbIcon(NbGlyph.mic),
              style: IconButton.styleFrom(
                fixedSize: const Size.square(_button),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                backgroundColor: Colors.transparent,
                foregroundColor: c.mutedFg.withValues(alpha: .6),
              ),
              onPressed: () => _micOldSnack(t.micNeedsUpdate),
            )
          : RecordButton(
              key: const ValueKey('mic'),
              session: widget.session,
              enabled: widget.micEnabled ?? open,
              available: widget.whisperAvailable,
              onUnavailable: widget.onWhisperMissing,
            );
      final Widget send = IconButton(
        key: const ValueKey('send'),
        tooltip: widget.sending ? t.attachUploading : t.send,
        icon: widget.sending
            ? const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const NbIcon(NbGlyph.send),
        style: IconButton.styleFrom(
          fixedSize: const Size.square(_button),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          backgroundColor: widget.canSend ? c.primary : c.muted,
          foregroundColor: widget.canSend ? c.primaryFg : c.mutedFg,
          disabledBackgroundColor: c.muted,
          disabledForegroundColor: c.mutedFg,
        ),
        onPressed: widget.canSend ? widget.onSend : null,
      );
      final trailing = AnimatedSwitcher(
        duration: const Duration(milliseconds: 180),
        transitionBuilder: (child, anim) => ScaleTransition(
          scale: anim,
          child: FadeTransition(opacity: anim, child: child),
        ),
        child: showMic
            ? mic
            : widget.showMic
            ? Row(
                key: const ValueKey('mic-send'),
                mainAxisSize: MainAxisSize.min,
                children: [
                  mic,
                  const SizedBox(width: _inset),
                  send,
                ],
              )
            : send,
      );
      return Container(
        constraints: const BoxConstraints(minHeight: 48),
        decoration: BoxDecoration(
          color: c.popover.withValues(alpha: .95),
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: c.border),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Stack(
                children: [
                  // kept while recording: the typed text stays for after
                  Visibility(
                    visible: !recording,
                    maintainState: true,
                    maintainSize: true,
                    maintainAnimation: true,
                    // one line is as tall as the action button and its insets, centred in it, so that the controls
                    // beside it are centred too; more lines grow it
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                        minHeight: _button + 2 * _inset,
                      ),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: field,
                      ),
                    ),
                  ),
                  if (recording)
                    Positioned.fill(
                      child: Align(
                        alignment: Alignment.center,
                        child: RecordRow(session: widget.session),
                      ),
                    ),
                ],
              ),
            ),
            if (widget.onAttach != null && !typed && !recording)
              Padding(
                key: const ValueKey('attach-slot'),
                padding: const EdgeInsets.fromLTRB(
                  0,
                  _inset,
                  8 - _inset,
                  _inset,
                ),
                child: IconButton(
                  key: const ValueKey('attach'),
                  tooltip: t.attach,
                  icon: const NbIcon(NbGlyph.clip),
                  style: IconButton.styleFrom(
                    fixedSize: const Size.square(_button),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: open ? widget.onAttach : null,
                ),
              ),
            // keyed: the button (and a recording in it) survives the paperclip leaving the row
            Padding(
              key: const ValueKey('trailing-slot'),
              padding: const EdgeInsets.all(_inset),
              child: CompositedTransformTarget(
                link: _trailing,
                child: trailing,
              ),
            ),
            ?widget.floating?.call(_trailing),
          ],
        ),
      );
    },
  );
}
