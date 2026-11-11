// The message field: the text, with the paperclip and the mic (Send once there is something to send) inside it, and a
// floating Stop while the agent works. Sending while the agent works asks first and then interrupts (force), as the
// desktop does; a send the window refuses gives its text back. A draft is written whenever; the send waits for a tab
// that owns a live window.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PlatformException, Uint8List;
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import '../dictation/whisper_sheet.dart';
import '../media/attach.dart';
import '../media/gallery.dart';
import '../media/picker.dart';
import '../theme.dart';
import '../ui/blur_band.dart';
import '../ui/nb_icon.dart';
import '../store/voice_lang.dart';
import '../voice/record_session.dart';
import '../voice/recorder.dart';
import 'attach_sheet.dart';
import 'message_field.dart';
import 'send_now.dart';
import 'window_tab.dart';

/// How an image is prepared before its upload; replaced in tests, where an isolate cannot be waited for.
@visibleForTesting
Future<Prepared> Function(Uint8List, String) prepareFor = prepareImage;

/// An image of the message being written, prepared and uploaded in the background. It keeps only its prepared [bytes]
/// (the thumbnail; null until prepared), never the original. It holds [ref] once uploaded and [failed] when the upload
/// did not work (the image stays, marked, until the user removes it).
class _Draft {
  Uint8List? bytes;
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
  late final _session = RecordSession(
    onRecorded: _recorded,
    onError: _recordFailed,
  );

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
    _session.dispose();
    super.dispose();
  }

  void _onRefused(ServerEventSendRefused r) {
    final last = _last;
    if (!mounted || last == null || last.id != r.id) return;
    widget.tab.comments.unsending(last.comments);
    if (_text.text.isEmpty) _text.text = last.text;
    // as the desktop: the images come back only into an empty draft, they are not mixed with newer ones
    if (_drafts.isEmpty) setState(() => _drafts.addAll(last.images));
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
    final choice = await showAttachSheet(context);
    if (choice == null || !mounted) return;
    final t = AppLocalizations.of(context);
    final Picked got;
    try {
      got = switch (choice) {
        AttachFrom(:final source) => await pickImages(source),
        AttachItems(:final items) => await gallerySource.take(items),
      };
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
    if (got.unreadable.isNotEmpty) {
      _say(t.attachUnreadable(got.unreadable.join(', ')));
    }
    for (final p in got.images) {
      final d = _Draft();
      setState(() => _drafts.add(d));
      unawaited(_upload(d, p));
    }
  }

  void _say(String message) => ScaffoldMessenger.of(
    context,
  ).showSnackBar(SnackBar(content: Text(message)));

  /// The images wait here for their turn: preparing one decodes it in an isolate (a photo peaks near 100 MB), so one
  /// at a time. Uploads overlap.
  Future<void> _turn = Future.value();

  /// [p] read, prepared and its file deleted, when its turn comes; null when it was removed or the composer left
  /// meanwhile. The type comes from the bytes, the provider's own only when they say nothing.
  Future<Prepared?> _prepare(_Draft d, PickedImage p) {
    final run = _turn.then((_) async {
      try {
        if (!mounted || !_drafts.contains(d)) return null;
        final bytes = await p.read();
        final seen = imageMime(bytes, p.name);
        return await prepareFor(bytes, seen == 'image/*' ? p.mime : seen);
      } finally {
        await p.delete();
      }
    });
    _turn = run.then<void>((_) {}, onError: (Object _) {});
    return run;
  }

  Future<void> _upload(_Draft d, PickedImage p) async {
    final t = AppLocalizations.of(context);
    try {
      final prepared = await _prepare(d, p);
      if (prepared == null) return;
      d.bytes = prepared.bytes;
      if (mounted) setState(() {});
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

  /// A recording was released (or sent from the lock or the preview): it goes to the window as a voice message of its
  /// own, never with the typed text or the images; the pending comments ride along (the mic shows while the field is
  /// empty, comments or not). While the agent works it asks, as a typed send does; dismissed, the recording waits in the
  /// preview.
  Future<void> _recorded(Uint8List wav, Duration length) async {
    if (!mounted) return;
    // read now: the chat may be left while the question is up, and the recording still goes out (the outbox outlives it)
    final lang = voiceLangOf(context);
    final textLang = Localizations.localeOf(context).languageCode;
    final outbox = widget.tab.voiceOutbox;
    var force = false;
    if (widget.tab.busy) {
      final choice = await askSendNow(context);
      if (choice == null) {
        // dismissed: the recording waits in the preview, if there is still one to wait in
        if (mounted) _session.restore(wav);
        return;
      }
      force = choice == 'force';
    }
    // only their ids now: the batch is written when the recording leaves (see WindowTab.composeFor), when it is known
    // which of them are still pending. A window older than 16 gets the recording alone and they stay pending.
    final ids = widget.tab.voiceCommentsProtocol
        ? [for (final c in widget.tab.comments.sendable) c.id]
        : const <String>[];
    outbox.submit(
      wav,
      lang,
      force: force,
      commentIds: ids,
      commentLang: textLang,
    );
  }

  void _recordFailed(RecordFailure why) {
    if (!mounted) return;
    final t = AppLocalizations.of(context);
    _say(why == RecordFailure.denied ? t.dictationDenied : t.voiceRecordFailed);
  }

  /// Back (or any pop) with a recording: it stops into the preview and the user chooses; nothing is dropped unasked.
  Future<void> _leave() async {
    if (_session.phase == RecordPhase.recording && _session.holding) return;
    await _session.stopToPreview();
    if (!mounted || _session.phase != RecordPhase.preview) return;
    final t = AppLocalizations.of(context);
    final nav = Navigator.of(context);
    final choice = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(t.voiceLeaveTitle),
        content: Text(t.voiceLeaveBody),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: Text(t.cancel)),
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
      await _session.send();
      // the busy question was dismissed: the recording is back in the preview, and the chat stays
      if (_session.phase == RecordPhase.preview) return;
    } else {
      _session.cancel();
    }
    // the outbox has the message now (it outlives this chat)
    unawaited(nav.maybePop());
  }

  Future<void> _send() async {
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
      final choice = await askSendNow(context);
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
    final batch = widget.tab.composeComments(
      text,
      comments,
      lang,
      own: [for (final d in drafts) d.ref!],
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
    listenable: Listenable.merge([widget.tab, widget.tab.comments, _session]),
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final open = widget.tab.state == TabState.open;
      final c = Theme.of(context).extension<NbColors>()!;
      final uploading = _uploading;
      // pending comments are not content here: they go from the Comments tab, or ride along with a recording
      final hasContent = _text.text.trim().isNotEmpty || _drafts.isNotEmpty;
      final canSend = open && !uploading && !_failed && hasContent;
      final recording = _session.active;
      // the mic while the field is empty (and no image waits), Send otherwise; a window older than protocol 14 has no voice: its mic
      // is greyed and says why on a tap, not missing
      final mic = !hasContent || recording;
      return PopScope(
        // a recording is never dropped by a back press: it is asked about
        canPop: !recording,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _leave();
        },
        child: Padding(
          key: const ValueKey('composer'),
          padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_drafts.isNotEmpty) _strip(t, c),
              _field(
                t,
                open: open,
                recording: recording,
                mic: mic,
                canSend: canSend,
                uploading: uploading,
              ),
            ],
          ),
        ),
      );
    },
  );

  /// The rounded field with everything inside it (see [MessageField]). Grey Stop (while the agent works) and paperclip
  /// (while text is typed) float 12 above the right button.
  Widget _field(
    AppLocalizations t, {
    required bool open,
    required bool recording,
    required bool mic,
    required bool canSend,
    required bool uploading,
  }) => MessageField(
    controller: _text,
    focus: widget.focus,
    hint: t.messageHint,
    session: _session,
    open: open,
    voiceProtocol: widget.tab.voiceProtocol,
    whisperAvailable: widget.tab.whisper,
    onWhisperMissing: () => showWhisperSheet(context, widget.tab),
    showMic: mic,
    showSend: !mic,
    canSend: canSend,
    sending: uploading,
    onSend: _send,
    onAttach: _attach,
    snackAnchor: () => context,
    // the layout of the row does not change: the portal floats over the feed. The hold hides it (the big circle and
    // the lock are drawn over that place); a locked recording leaves the finger, and the turn can still be stopped.
    // The paperclip floats while text is typed (it left the row to leave the text its width), never while recording.
    floating: (link) {
      final holding = recording && _session.holding;
      final stop = open && widget.tab.busy && !holding;
      final clip = _text.text.isNotEmpty && !recording && !holding;
      final room = FloatingRoom.maybeOf(context);
      if (room != null && room.value != clip) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) room.value = clip;
        });
      }
      return stop || clip
          ? _FloatingButtons(
              link: link,
              buttons: [
                if (clip)
                  (
                    key: const ValueKey('attach-floating'),
                    label: t.attach,
                    glyph: NbGlyph.clip,
                    onTap: open ? _attach : null,
                  ),
                if (stop)
                  (
                    key: const ValueKey('stop'),
                    label: t.stop,
                    glyph: NbGlyph.stop,
                    onTap: () =>
                        widget.tab.send(const ClientMessageInterrupt()),
                  ),
              ],
            )
          : const SizedBox.shrink();
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
                    child: d.bytes == null
                        ? null
                        : Image.memory(
                            d.bytes!,
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

/// One floating round button: a key, the label of its tooltip and Semantics, a glyph and its action (null: off).
typedef _Floater = ({
  Key key,
  String label,
  NbGlyph glyph,
  VoidCallback? onTap,
});

/// Grey 44 round buttons 12 above the right button of the field (Stop while the agent works, the paperclip once text is
/// typed), on the overlay so they float over the feed and take no room from it. The last one sits over the right button,
/// the others to its left, 8 apart.
class _FloatingButtons extends StatefulWidget {
  const _FloatingButtons({required this.link, required this.buttons});
  final LayerLink link;
  final List<_Floater> buttons;

  @override
  State<_FloatingButtons> createState() => _FloatingButtonsState();
}

class _FloatingButtonsState extends State<_FloatingButtons> {
  static const _size = 44.0;
  final _portal = OverlayPortalController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _portal.show();
    });
  }

  @override
  Widget build(BuildContext context) => OverlayPortal(
    controller: _portal,
    overlayChildBuilder: (context) {
      final c = Theme.of(context).extension<NbColors>()!;
      return CompositedTransformFollower(
        link: widget.link,
        showWhenUnlinked: false,
        // the last button is centred over the right button: the row ends half a button past its centre
        targetAnchor: Alignment.topCenter,
        followerAnchor: Alignment.bottomRight,
        offset: const Offset(_size / 2, -12),
        child: Align(
          alignment: Alignment.bottomRight,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final (i, b) in widget.buttons.indexed) ...[
                if (i > 0) const SizedBox(width: 8),
                // named and tappable for TalkBack (the button's own tooltip is not a label)
                Semantics(
                  label: b.label,
                  button: true,
                  onTap: b.onTap,
                  excludeSemantics: true,
                  child: IconButton(
                    key: b.key,
                    tooltip: b.label,
                    icon: NbIcon(b.glyph),
                    style: IconButton.styleFrom(
                      fixedSize: const Size.square(_size),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      backgroundColor: c.muted,
                      foregroundColor: c.foreground,
                    ),
                    onPressed: b.onTap,
                  ),
                ),
              ],
            ],
          ),
        ),
      );
    },
  );
}
