// The message field, shared by the chat and the comment sheet: one rounded field with the text, then the paperclip (when
// the page has one, and only while there is no text) and at the right the mic, which becomes Send once there is something
// to send. A recording takes the text's place. The page decides what is sent and what a recording does; this only draws
// and routes the taps, so both fields have the same geometry and the same states. While the caret is on a list item or
// in a code block, ⇥ and ⇤ float over the field's left end (a phone keyboard has no Tab).

import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../voice/record_button.dart';
import '../voice/record_row.dart';
import '../voice/record_session.dart';
import 'markdown_text.dart';

/// The mic, Send and the paperclip inside the field.
const _button = 40.0;

/// The buttons floating over the field (as the chat's Stop and paperclip).
const _floating = 44.0;

/// The space around the action button (and between it and the paperclip: 8 beside it, the paperclip's own).
const _inset = 3.0;

class MessageField extends StatefulWidget {
  const MessageField({
    super.key,
    required this.controller,
    required this.hint,
    required this.session,
    required this.open,
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
    this.fill,
  });

  /// What the field sits on, when it is not the chat's background (the comment sheet's own colour).
  final Color? fill;
  final TextEditingController controller;
  final FocusNode? focus;
  final String hint;
  final bool autofocus;
  final int maxLines;
  final RecordSession session;

  /// The page can take input now (the window is open); the mic and the paperclip are off otherwise.
  final bool open;

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

  @override
  State<MessageField> createState() => _MessageFieldState();
}

class _MessageFieldState extends State<MessageField> {
  final _trailing = LayerLink(), _leading = LayerLink();

  /// The field's focus when the page gives none: ⇥ and ⇤ show only while it is focused.
  FocusNode? _own;
  FocusNode get _focus => widget.focus ?? (_own ??= FocusNode());

  @override
  void dispose() {
    _own?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.controller, widget.session, _focus]),
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final recording = widget.session.active;
      final text = widget.controller;
      final nest =
          text is MarkdownText && _focus.hasFocus && !recording && text.canNest;
      final typed = widget.controller.text.isNotEmpty;
      final open = widget.open;
      final field = TextField(
        controller: widget.controller,
        focusNode: _focus,
        autofocus: widget.autofocus,
        // a draft is written also while the window is away; only the send waits for it
        minLines: 1,
        maxLines: widget.maxLines,
        textCapitalization: TextCapitalization.sentences,
        // code blocks and lists as on the computer (typed only: a paste goes in as it is)
        inputFormatters: [
          if (widget.controller case MarkdownText(:final shell))
            MarkdownBlocks(shell: shell),
        ],
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
      final Widget mic = RecordButton(
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
      final box = Container(
        // as tall as the button and its insets: the field has no border line to add to it
        constraints: const BoxConstraints(minHeight: _button + 2 * _inset),
        decoration: BoxDecoration(
          color: widget.fill ?? c.fieldOver(c.background),
          borderRadius: BorderRadius.circular(24),
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
            if (nest) _Nest(link: _leading, text: text),
          ],
        ),
      );
      return CompositedTransformTarget(link: _leading, child: box);
    },
  );
}

/// ⇥ and ⇤ over the field's left end, as the chat's Stop floats over its right: over the feed, so the field does not
/// move. A tap is the field's own (it keeps the focus and the keyboard); a button with nowhere to go is off.
class _Nest extends StatefulWidget {
  const _Nest({required this.link, required this.text});
  final LayerLink link;
  final MarkdownText text;

  @override
  State<_Nest> createState() => _NestState();
}

class _NestState extends State<_Nest> {
  final _portal = OverlayPortalController()..show();

  @override
  Widget build(BuildContext context) => OverlayPortal(
    controller: _portal,
    overlayChildBuilder: (context) {
      final text = widget.text;
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      Widget button(int dir, Key key, String label, NbGlyph glyph) {
        final can = !identical(nested(text.value, dir), text.value);
        final tap = can ? () => text.nest(dir) : null;
        // named and tappable for TalkBack (the button's own tooltip is not a label)
        return Semantics(
          label: label,
          button: true,
          onTap: tap,
          excludeSemantics: true,
          child: IconButton(
            key: key,
            tooltip: label,
            icon: NbIcon(glyph),
            style: IconButton.styleFrom(
              fixedSize: const Size.square(_floating),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              backgroundColor: c.muted,
              foregroundColor: c.foreground,
              disabledBackgroundColor: c.muted,
              disabledForegroundColor: c.mutedFg,
            ),
            onPressed: tap,
          ),
        );
      }

      return CompositedTransformFollower(
        link: widget.link,
        showWhenUnlinked: false,
        // on the line of the chat's floating buttons: 12 above the field's buttons
        targetAnchor: Alignment.topLeft,
        followerAnchor: Alignment.bottomLeft,
        offset: const Offset(0, _inset - 12),
        child: Align(
          alignment: Alignment.bottomLeft,
          // a tap here is not a tap outside the field: a mouse or a stylus would take its focus
          child: TextFieldTapRegion(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                button(
                  -1,
                  const ValueKey('nest-out'),
                  t.outdent,
                  NbGlyph.outdent,
                ),
                const SizedBox(width: 8),
                button(1, const ValueKey('nest-in'), t.indent, NbGlyph.indent),
              ],
            ),
          ),
        ),
      );
    },
  );
}
