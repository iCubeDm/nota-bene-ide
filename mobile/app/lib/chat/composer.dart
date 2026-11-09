// The message field. Sending while the agent works asks first and then interrupts (force), as the desktop does; a send
// the window refuses gives its text back. Disabled, not queued, while the tab does not own a live window.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import '../comments/comments.dart';
import '../dictation/dictation.dart';
import '../dictation/host_dictation.dart';
import '../dictation/mic_button.dart';
import '../files/image_screen.dart' show windowHttp;
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'window_tab.dart';

class Composer extends StatefulWidget {
  const Composer({super.key, required this.tab});
  final WindowTab tab;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _text = TextEditingController();
  StreamSubscription<ServerEventSendRefused>? _refused;
  ({String id, String text, Set<String> comments})? _last;

  @override
  void initState() {
    super.initState();
    _refused = widget.tab.refusals.listen(_onRefused);
    _text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _refused?.cancel();
    _text.dispose();
    super.dispose();
  }

  void _onRefused(ServerEventSendRefused r) {
    final last = _last;
    if (!mounted || last == null || last.id != r.id) return;
    widget.tab.comments.unsending(last.comments);
    if (_text.text.isEmpty) _text.text = last.text;
    final t = AppLocalizations.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          r.reason == ServerEventSendRefusedReason.switching
              ? t.refusedSwitching
              : t.refusedBusy,
        ),
      ),
    );
  }

  Future<void> _send() async {
    // a running dictation must not write into the field after it is read (or cleared)
    MicButton.cancelRunning();
    final text = _text.text.trim();
    if (text.isEmpty && widget.tab.comments.sendable.isEmpty) return;
    var force = false;
    if (widget.tab.busy) {
      // as on the desktop: a message while the agent works waits for its turn, unless it is sent now and interrupts
      final t = AppLocalizations.of(context);
      final choice = await showDialog<String>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(t.sendNowTitle),
          content: Text(t.sendNowBody),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c),
              child: Text(t.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c, 'queue'),
              child: Text(t.sendAfter),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(c, 'force'),
              child: Text(t.sendNow),
            ),
          ],
        ),
      );
      if (choice == null || !mounted) return;
      force = choice == 'force';
    }
    // read now: the desktop may have sent or changed them while the dialog was up
    final comments = widget.tab.comments.sendable;
    if (text.isEmpty && comments.isEmpty) return;
    final id = uuidV4();
    // the text stays when the window is not there to take it (the tab went offline or was taken meanwhile)
    // the pending comments leave with it, in the desktop's batch; the server marks them sent
    final lang = Localizations.localeOf(context).languageCode;
    final versions = widget.tab.fileVersions;
    final batch = composeSend(
      text,
      comments,
      widget.tab.feed,
      lang,
      // "changed" only when the current version is known (the file was opened here) and differs from the drawn one
      staleOf: (c) => switch (c.anchor) {
        MediaAnchor(:final source, :final version?) when source.ref == null =>
          versions[source.path] != null && versions[source.path] != version,
        _ => false,
      },
    );
    final sent = widget.tab.send(
      ClientMessageSend(
        id: id,
        text: batch.text,
        force: force ? true : null,
        commentIds: comments.isEmpty ? null : [for (final c in comments) c.id],
        images: batch.images.isEmpty ? null : batch.images,
      ),
    );
    if (!sent) return;
    final ids = {for (final c in comments) c.id};
    widget.tab.comments.sending(ids);
    _last = (id: id, text: text, comments: ids);
    _text.clear();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.tab, widget.tab.comments]),
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final open = widget.tab.state == TabState.open;
      final c = Theme.of(context).extension<NbColors>()!;
      final canSend =
          open &&
          (_text.text.trim().isNotEmpty ||
              widget.tab.comments.sendable.isNotEmpty);
      // while the agent works and there is nothing to send, the send slot is the stop button
      final stop = open && widget.tab.busy && !canSend;
      return Padding(
        key: const ValueKey('composer'),
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Container(
                constraints: const BoxConstraints(minHeight: 40),
                decoration: BoxDecoration(
                  color: c.popover.withValues(alpha: .95),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: c.border),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _text,
                        enabled: open,
                        minLines: 1,
                        maxLines: 6,
                        textCapitalization: TextCapitalization.sentences,
                        decoration: InputDecoration(
                          hintText: open ? t.messageHint : t.cannotSend,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          isDense: true,
                          contentPadding: const EdgeInsets.fromLTRB(
                            16,
                            11,
                            4,
                            11,
                          ),
                        ),
                      ),
                    ),
                    MicButton(
                      controller: _text,
                      enabled: open,
                      chooser: () =>
                          open &&
                              widget.tab.capabilities?.dictation == 'whisper' &&
                              !widget.tab.hostWhisperOff
                          ? HostDictation(
                              () => windowHttp(widget.tab),
                              onHostOff: () => widget.tab.hostWhisperOff = true,
                            )
                          : dictation,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 6),
            if (stop)
              IconButton(
                key: const ValueKey('stop'),
                tooltip: t.stop,
                icon: const NbIcon(NbGlyph.stop),
                style: IconButton.styleFrom(
                  fixedSize: const Size.square(40),
                  backgroundColor: c.destructive,
                  foregroundColor: c.background,
                ),
                onPressed: () =>
                    widget.tab.send(const ClientMessageInterrupt()),
              )
            else
              IconButton(
                key: const ValueKey('send'),
                tooltip: t.send,
                icon: const NbIcon(NbGlyph.send),
                style: IconButton.styleFrom(
                  fixedSize: const Size.square(40),
                  backgroundColor: canSend ? c.primary : c.muted,
                  foregroundColor: canSend ? c.primaryFg : c.mutedFg,
                  disabledBackgroundColor: c.muted,
                  disabledForegroundColor: c.mutedFg,
                ),
                onPressed: canSend ? _send : null,
              ),
          ],
        ),
      );
    },
  );
}
