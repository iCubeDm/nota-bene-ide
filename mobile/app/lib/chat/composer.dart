// The message field: the text, with the paperclip and the mic (Send once there is something to send) inside it, and a
// floating Stop while the agent works. Sending while the agent works asks first and then interrupts (force), as the
// desktop does; a send the window refuses gives its text back. A draft is written whenever; the send waits for a tab
// that owns a live window.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PlatformException, Uint8List;
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import '../comments/comments.dart';
import '../dictation/whisper_sheet.dart';
import '../media/attach.dart';
import '../media/picker.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../store/voice_lang.dart';
import '../voice/record_button.dart';
import '../voice/record_row.dart';
import '../voice/record_session.dart';
import '../voice/recorder.dart';
import 'attach_sheet.dart';
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

/// The mic, Send and the paperclip inside the field.
const _button = 40.0;

/// The space around the action button (and between it and the paperclip: 8 beside it, the paperclip's own).
const _inset = 3.0;

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
  final _trailing = LayerLink();
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
  /// own, never with the typed text, the images or the pending comments. While the agent works it asks, as a typed
  /// send does; dismissed, the recording waits in the preview.
  Future<void> _recorded(Uint8List wav, Duration length) async {
    if (!mounted) return;
    // read now: the chat may be left while the question is up, and the recording still goes out (the outbox outlives it)
    final lang = voiceLangOf(context);
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
    outbox.submit(wav, lang, force: force);
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
    listenable: Listenable.merge([widget.tab, widget.tab.comments, _session]),
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final open = widget.tab.state == TabState.open;
      final c = Theme.of(context).extension<NbColors>()!;
      final uploading = _uploading;
      final hasContent =
          _text.text.trim().isNotEmpty ||
          widget.tab.comments.sendable.isNotEmpty ||
          _drafts.isNotEmpty;
      final canSend = open && !uploading && !_failed && hasContent;
      final recording = _session.active;
      // the mic while there is nothing to send, Send otherwise; a window older than protocol 14 has no voice: its mic
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
                context,
                t,
                c,
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

  /// The old host's mic says why it does nothing: a snackbar floating above the message field, not over it.
  void _micOldSnack(BuildContext ctx, String text) {
    final messenger = ScaffoldMessenger.maybeOf(ctx);
    final scaffold = Scaffold.maybeOf(ctx)?.context.findRenderObject();
    final box = context.findRenderObject();
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

  /// The rounded field with everything inside it: the text, then the paperclip (only while there is no text) and at the
  /// right the mic, which becomes Send once there is something to send. A recording takes the text's place. While the
  /// agent works a grey Stop floats 12 above the right button.
  Widget _field(
    BuildContext context,
    AppLocalizations t,
    NbColors c, {
    required bool open,
    required bool recording,
    required bool mic,
    required bool canSend,
    required bool uploading,
  }) {
    final typed = _text.text.isNotEmpty;
    final field = TextField(
      controller: _text,
      focusNode: widget.focus,
      // a draft is written also while the window is away; only the send waits for it
      minLines: 1,
      maxLines: 6,
      textCapitalization: TextCapitalization.sentences,
      decoration: InputDecoration(
        hintText: t.messageHint,
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        disabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        isDense: true,
        contentPadding: const EdgeInsets.fromLTRB(16, 8, 4, 8),
      ),
    );
    final trailing = AnimatedSwitcher(
      duration: const Duration(milliseconds: 180),
      transitionBuilder: (child, anim) => ScaleTransition(
        scale: anim,
        child: FadeTransition(opacity: anim, child: child),
      ),
      child: mic && !widget.tab.voiceProtocol
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
              onPressed: () => _micOldSnack(context, t.micNeedsUpdate),
            )
          : mic
          ? RecordButton(
              key: const ValueKey('mic'),
              session: _session,
              enabled: open,
              available: widget.tab.whisper,
              onUnavailable: () => showWhisperSheet(context, widget.tab),
            )
          : IconButton(
              key: const ValueKey('send'),
              tooltip: uploading ? t.attachUploading : t.send,
              icon: uploading
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const NbIcon(NbGlyph.send),
              style: IconButton.styleFrom(
                fixedSize: const Size.square(_button),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                backgroundColor: canSend ? c.primary : c.muted,
                foregroundColor: canSend ? c.primaryFg : c.mutedFg,
                disabledBackgroundColor: c.muted,
                disabledForegroundColor: c.mutedFg,
              ),
              onPressed: canSend ? _send : null,
            ),
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
                  // one line is as tall as the action button and its insets, centred in it, so that the controls beside
                  // it are centred too; more lines grow it
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(
                      minHeight: _button + 2 * _inset,
                    ),
                    child: Align(alignment: Alignment.centerLeft, child: field),
                  ),
                ),
                if (recording)
                  Positioned.fill(
                    child: Align(
                      alignment: Alignment.center,
                      child: RecordRow(session: _session),
                    ),
                  ),
              ],
            ),
          ),
          if (!typed && !recording)
            Padding(
              key: const ValueKey('attach-slot'),
              padding: const EdgeInsets.fromLTRB(0, _inset, 8 - _inset, _inset),
              child: IconButton(
                key: const ValueKey('attach'),
                tooltip: t.attach,
                icon: const NbIcon(NbGlyph.clip),
                style: IconButton.styleFrom(
                  fixedSize: const Size.square(_button),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                onPressed: open ? _attach : null,
              ),
            ),
          // keyed: the button (and a recording in it) survives the paperclip leaving the row
          Padding(
            key: const ValueKey('trailing-slot'),
            padding: const EdgeInsets.all(_inset),
            child: CompositedTransformTarget(link: _trailing, child: trailing),
          ),
          // the layout of the row does not change: the portal floats over the feed. Only the hold hides it (the big
          // circle and the lock are drawn over that place); a locked recording leaves the finger, and the turn can
          // still be stopped
          if (open && widget.tab.busy && !(recording && _session.holding))
            _FloatingStop(
              link: _trailing,
              onStop: () => widget.tab.send(const ClientMessageInterrupt()),
            ),
        ],
      ),
    );
  }

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

/// Stop while the agent works: a grey 44 round button 12 above the right button of the field, on the overlay so it floats
/// over the feed and takes no room from it.
class _FloatingStop extends StatefulWidget {
  const _FloatingStop({required this.link, required this.onStop});
  final LayerLink link;
  final VoidCallback onStop;

  @override
  State<_FloatingStop> createState() => _FloatingStopState();
}

class _FloatingStopState extends State<_FloatingStop> {
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
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      return CompositedTransformFollower(
        link: widget.link,
        showWhenUnlinked: false,
        targetAnchor: Alignment.topCenter,
        followerAnchor: Alignment.bottomCenter,
        offset: const Offset(0, -12),
        child: Align(
          alignment: Alignment.bottomCenter,
          // named and tappable for TalkBack (the button's own tooltip is not a label)
          child: Semantics(
            label: t.stop,
            button: true,
            onTap: widget.onStop,
            excludeSemantics: true,
            child: IconButton(
              key: const ValueKey('stop'),
              tooltip: t.stop,
              icon: const NbIcon(NbGlyph.stop),
              style: IconButton.styleFrom(
                fixedSize: const Size.square(44),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                backgroundColor: c.muted,
                foregroundColor: c.foreground,
              ),
              onPressed: widget.onStop,
            ),
          ),
        ),
      );
    },
  );
}
