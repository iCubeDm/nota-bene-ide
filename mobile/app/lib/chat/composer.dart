// The message field. Sending while the agent works asks first and then interrupts (force), as the desktop does; a send
// the window refuses gives its text back. Disabled, not queued, while the tab does not own a live window.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PlatformException, Uint8List;
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import '../comments/comments.dart';
import '../dictation/record_bar.dart';
import '../dictation/voice_button.dart';
import '../dictation/voice_chooser.dart';
import '../media/attach.dart';
import '../media/picker.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'attach_sheet.dart';
import 'window_tab.dart';

/// How an image is prepared before its upload; replaced in tests, where an isolate cannot be waited for.
@visibleForTesting
Future<Prepared> Function(Uint8List, String) prepareFor = prepareImage;

/// An image of the message being written: shown at once from [bytes], uploaded in the background. It holds [ref] once
/// uploaded and [failed] when the upload did not work (the image stays, marked, until the user removes it).
class _Draft {
  _Draft(this.bytes);
  final Uint8List bytes;
  ImageRef? ref;
  bool failed = false;
  bool get pending => ref == null && !failed;
}

class Composer extends StatefulWidget {
  const Composer({super.key, required this.tab, this.controller, this.focus});
  final WindowTab tab;

  /// The draft, when the page needs to write into it (Reply); the composer owns one otherwise.
  final TextEditingController? controller;
  final FocusNode? focus;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  late final _own = widget.controller == null ? TextEditingController() : null;
  TextEditingController get _text => widget.controller ?? _own!;
  StreamSubscription<ServerEventSendRefused>? _refused;
  ({String id, String text, Set<String> comments, List<_Draft> images})? _last;
  final _drafts = <_Draft>[];
  final _meter = VoiceMeter();
  VoiceState _voice = VoiceState.idle;

  @override
  void initState() {
    super.initState();
    _refused = widget.tab.refusals.listen(_onRefused);
    _text.addListener(_changed);
  }

  void _changed() => setState(() {});

  @override
  void dispose() {
    _text.removeListener(_changed);
    _refused?.cancel();
    _own?.dispose();
    _meter.dispose();
    super.dispose();
  }

  void _onRefused(ServerEventSendRefused r) {
    final last = _last;
    if (!mounted || last == null || last.id != r.id) return;
    widget.tab.comments.unsending(last.comments);
    if (_text.text.isEmpty) _text.text = last.text;
    // as the desktop: the images come back only into an empty draft, they are not mixed with newer ones
    if (_drafts.isEmpty) _drafts.addAll(last.images);
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

  /// Picks from [source], then prepares and uploads each image in the background.
  Future<void> _attach() async {
    final source = await showAttachSheet(context);
    if (source == null || !mounted) return;
    final t = AppLocalizations.of(context);
    final ({List<PickedImage> images, List<String> skipped}) got;
    try {
      got = await pickImages(source);
    } on PlatformException catch (e) {
      if (!mounted) return;
      _say(switch (e.code) {
        'denied' => t.attachDenied,
        'busy' => t.attachBusy,
        'unavailable' => t.attachUnavailable,
        _ => t.attachRead,
      });
      return;
    }
    if (!mounted) return;
    if (got.skipped.isNotEmpty) _say(t.attachTooLarge(got.skipped.join(', ')));
    for (final p in got.images) {
      final d = _Draft(p.bytes);
      setState(() => _drafts.add(d));
      unawaited(_upload(d, p));
    }
  }

  void _say(String message) => ScaffoldMessenger.of(
    context,
  ).showSnackBar(SnackBar(content: Text(message)));

  Future<void> _upload(_Draft d, PickedImage p) async {
    final t = AppLocalizations.of(context);
    try {
      final prepared = await prepareFor(p.bytes, p.mime);
      // the label is the position at the send (`composeSend`); this one only has to be something
      final ref = await uploadImage(widget.tab, prepared, '');
      d.ref = ref;
    } on UnsupportedImage {
      if (mounted) {
        _drafts.remove(d);
        _say(t.attachUnsupported);
      }
    } on Object {
      d.failed = true;
      if (mounted) _say(t.attachFailed);
    }
    if (mounted) setState(() {});
  }

  bool get _uploading => _drafts.any((d) => d.pending);
  bool get _failed => _drafts.any((d) => d.failed);

  Future<void> _send() async {
    // a running dictation is finished first: its words are in the field before it is read (or cleared)
    await VoiceButton.finishRunning();
    if (!mounted) return;
    final text = _text.text.trim();
    if (_uploading || _failed) return;
    if (text.isEmpty &&
        widget.tab.comments.sendable.isEmpty &&
        _drafts.isEmpty) {
      return;
    }
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
    final drafts = List.of(_drafts);
    if (_uploading || _failed) return;
    if (text.isEmpty && comments.isEmpty && drafts.isEmpty) return;
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
      own: [for (final d in drafts) d.ref!],
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
    _last = (id: id, text: text, comments: ids, images: drafts);
    _text.clear();
    // only what was sent leaves: an image added while the dialog was up stays for the next message
    setState(() => _drafts.removeWhere(drafts.contains));
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.tab, widget.tab.comments]),
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final open = widget.tab.state == TabState.open;
      final c = Theme.of(context).extension<NbColors>()!;
      final uploading = _uploading;
      final canSend =
          open &&
          !uploading &&
          !_failed &&
          (_text.text.trim().isNotEmpty ||
              widget.tab.comments.sendable.isNotEmpty ||
              _drafts.isNotEmpty);
      // while the agent works and there is nothing to send, the send slot is the stop button
      final stop = open && widget.tab.busy && !canSend && _drafts.isEmpty;
      return Padding(
        key: const ValueKey('composer'),
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_drafts.isNotEmpty) _strip(t, c),
            Row(
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
                          child: Stack(
                            children: [
                              // kept while recording: the words still land in it
                              Visibility(
                                visible: _voice == VoiceState.idle,
                                maintainState: true,
                                maintainSize: true,
                                maintainAnimation: true,
                                child: TextField(
                                  controller: _text,
                                  focusNode: widget.focus,
                                  enabled: open,
                                  minLines: 1,
                                  maxLines: 6,
                                  textCapitalization:
                                      TextCapitalization.sentences,
                                  decoration: InputDecoration(
                                    hintText: open
                                        ? t.messageHint
                                        : t.cannotSend,
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
                              if (_voice != VoiceState.idle)
                                Positioned.fill(
                                  child: RecordBar(
                                    state: _voice,
                                    meter: _meter,
                                  ),
                                ),
                            ],
                          ),
                        ),
                        IconButton(
                          key: const ValueKey('attach'),
                          tooltip: t.attach,
                          icon: const NbIcon(NbGlyph.clip),
                          onPressed: open ? _attach : null,
                        ),
                        VoiceButton(
                          controller: _text,
                          enabled: open,
                          meter: _meter,
                          onState: (v) => setState(() => _voice = v),
                          chooser: voiceChooser(widget.tab),
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
                    tooltip: uploading ? t.attachUploading : t.send,
                    icon: uploading
                        ? const SizedBox.square(
                            dimension: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const NbIcon(NbGlyph.send),
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
          ],
        ),
      );
    },
  );

  /// The drafts' thumbnails above the pill: each with its remove cross, a failed one with a red frame.
  Widget _strip(AppLocalizations t, NbColors c) => SizedBox(
    height: 64,
    child: Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          for (final d in _drafts)
            Padding(
              key: ValueKey(d.failed ? 'draft-failed' : 'draft'),
              padding: const EdgeInsets.only(right: 8),
              child: Stack(
                children: [
                  Container(
                    width: 60,
                    height: 60,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: d.failed ? c.destructive : c.border,
                        width: d.failed ? 2 : 1,
                      ),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: Image.memory(
                      d.bytes,
                      fit: BoxFit.cover,
                      cacheWidth: 120,
                      errorBuilder: (_, _, _) =>
                          const Center(child: Icon(Icons.image_outlined)),
                    ),
                  ),
                  if (d.pending)
                    const Positioned.fill(
                      child: Center(
                        child: SizedBox.square(
                          dimension: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      ),
                    ),
                  if (d.failed)
                    Positioned.fill(
                      child: Center(
                        child: Icon(
                          Icons.error_outline,
                          color: c.destructive,
                          size: 24,
                        ),
                      ),
                    ),
                  Positioned(
                    top: -4,
                    right: -4,
                    child: IconButton(
                      tooltip: t.attachRemove,
                      visualDensity: VisualDensity.compact,
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints.tightFor(
                        width: 24,
                        height: 24,
                      ),
                      icon: const NbIcon(NbGlyph.close, size: 12),
                      style: IconButton.styleFrom(
                        backgroundColor: c.popover,
                        foregroundColor: c.foreground,
                      ),
                      onPressed: () => setState(() => _drafts.remove(d)),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    ),
  );
}
