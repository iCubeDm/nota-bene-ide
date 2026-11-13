// The window's comments, as the desktop keeps them: the server holds the set of the session (the `comments` event, on
// connect and after every change). A change made here is queued as an op (protocol 19: `comment-op`, answered by the
// set's `ack`, `comment-ack` or `comment-refused`) and shown at once, folded over the server's set; the queue is on disk,
// so a change made offline outlives the app. A window older than 19 gets the whole set instead, as before. A send with
// `commentIds` makes the server mark them sent. The batch text is the desktop's (web/src/comments/compose.ts).
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/feed.dart' show Feed;
import '../chat/window_tab.dart' show uuidV4;
import '../media/shapes.dart';
import 'chat_anchor.dart';
import 'queue.dart';
import 'strings.g.dart';

/// The window that takes comment ops; an older one gets the whole set.
const opsProtocol = 19;

class Comments extends ChangeNotifier {
  Comments(
    this._send,
    this._session, {
    DateTime Function()? now,
    CommentQueue? queue,
  }) : _now = now ?? DateTime.now,
       _queue = queue ?? CommentQueue.memory() {
    // what the disk kept from an earlier run shows, and goes once the window is there
    _queue.ready.then((_) {
      notifyListeners();
      flush();
    });
  }

  final bool Function(ClientMessage) _send;
  final String? Function() _session;
  final DateTime Function() _now;
  final CommentQueue _queue;

  List<Comment> _server = const [];

  /// Whether the window takes ops (its hello); null before the first hello, when nothing goes out.
  bool? _ops;

  /// The queued ops sent on this socket: each goes once, and again on the next one.
  final _wired = <String>{};

  final _elsewhere = StreamController<void>.broadcast();

  /// A change made here was refused because the window changed or deleted the comment first.
  Stream<void> get changedElsewhere => _elsewhere.stream;

  /// The server's set with the queued changes of this session on top. An op made before the session had an id (null) is
  /// this one's: the server applies it here.
  List<Comment> get all {
    final now = _session();
    var items = _server;
    for (final q in _queue.ops) {
      if (q.sessionId != null && q.sessionId != now) continue;
      for (final o in q.ops) {
        items = _fold(items, o);
      }
    }
    return items;
  }

  static List<Comment> _fold(List<Comment> items, CommentOp o) => switch (o) {
    CommentOpRemove(:final id) => [
      for (final c in items)
        if (c.id != id) c,
    ],
    CommentOpAdd(:final comment, :final before)
        when !items.any((c) => c.id == comment.id) =>
      () {
        final at = before == null
            ? -1
            : items.indexWhere((c) => c.id == before);
        return [...items]..insert(at < 0 ? items.length : at, comment);
      }(),
    CommentOpEdit(:final comment) => [
      for (final c in items)
        c.id == comment.id && c.status != CommentStatus.sent ? comment : c,
    ],
    _ => items,
  };

  /// Every pending comment, held ones too: what the pane lists. What there is to send is [sendable].
  List<Comment> get pending => [
    for (final c in all)
      if (c.status == CommentStatus.pending) c,
  ];

  /// The one count of "comments to send" (strip, tab badge, pane header): [sendable]'s.
  int get toSend => sendable.length;

  /// sent with a message the server has not answered yet
  final _sending = <String>{};

  /// The ids a recording not yet in the window carries (the voice outbox's, kept on disk): not offered again.
  Set<String> Function() held = () => const {};

  /// Tells the listeners that [held] changed.
  void refresh() => notifyListeners();

  /// What the phone sends with a message: the pending text and media comments, their images with them. A page
  /// comment or a 3D model one, made on the desktop, stays pending for it (the phone cannot write their batch lines).
  List<Comment> get sendable {
    final away = held();
    return [
      for (final c in pendingOf(null))
        if (!_sending.contains(c.id) && !away.contains(c.id)) c,
    ];
  }

  /// The pending comments the phone can send, of [ids] (all when null), whoever holds them.
  List<Comment> pendingOf(Iterable<String>? ids) {
    final want = ids?.toSet();
    return [
      for (final c in pending)
        if ((want == null || want.contains(c.id)) &&
            switch (c.anchor) {
              TextAnchor() => true,
              MediaAnchor(:final camera) => camera == null,
              _ => false,
            })
          c,
    ];
  }

  /// [id] went out with a message the server has not answered yet.
  bool isSending(String id) => _sending.contains(id);

  /// [ids] left with a message: not offered again until the server's next set (or a refusal of that message).
  void sending(Set<String> ids) {
    _sending.addAll(ids);
    notifyListeners();
  }

  void unsending(Set<String> ids) {
    _sending.removeAll(ids);
    notifyListeners();
  }

  /// The media comments on [path] (this window's checkout).
  List<Comment> mediaFor(String path) => [
    for (final c in all)
      if (c.anchor case MediaAnchor(
        source: FileSource(path: final p, ref: null),
        camera: null,
      ) when p == path)
        c,
  ];

  List<Comment> forFile(String path) => [
    for (final c in all)
      if (c.anchor case TextAnchor(
        source: AnchorSourceFile(path: final p),
      ) when p == path)
        c,
  ];

  /// A new socket said hello: [protocol] says how the changes go, and what went on the old socket goes again.
  void hello(num? protocol) {
    _ops = (protocol ?? 0) >= opsProtocol;
    _wired.clear();
  }

  /// The server's set; [ack]: the ops it applied, off the queue now.
  void apply(List<Comment> items, {List<String>? ack}) {
    _server = List.unmodifiable(items);
    _sending.clear();
    if (ack != null) _drop(ack.toSet());
    notifyListeners();
    flush();
  }

  /// The window applied op [opId] to another session than the one shown.
  void acked(String opId) {
    _drop({opId});
    notifyListeners();
  }

  /// The window refused op [opId]: gone or sent, it is dropped (the comment changed elsewhere); failed (the window could
  /// not store it), it stays queued and goes on the next socket, not at once, which would be refused again.
  void refused(String opId, CommentRefusal reason) {
    if (reason == CommentRefusal.failed) return;
    _drop({opId});
    notifyListeners();
    _elsewhere.add(null);
  }

  void _drop(Set<String> opIds) {
    final n = _queue.ops.length;
    _queue.ops.removeWhere((o) => opIds.contains(o.opId));
    _wired.removeAll(opIds);
    if (_queue.ops.length != n) _queue.save();
  }

  /// Sends what the window has not had: the queued ops not on this socket yet, in order (the socket keeps it, and an op
  /// applied twice changes nothing, so a message sent after them finds them applied). A window older than 19 gets the
  /// set with them instead, which is then its set; nothing goes before the first hello or while the tab is not open.
  void flush() {
    final ops = _ops;
    if (ops == null || _queue.ops.isEmpty) return;
    if (!ops) {
      final items = all;
      if (!_send(ClientMessageComments(sessionId: _session(), items: items))) {
        return;
      }
      _server = List.unmodifiable(items);
      _queue.ops.clear();
      _queue.save();
      notifyListeners();
      return;
    }
    for (final q in _queue.ops) {
      if (_wired.contains(q.opId)) continue;
      if (!_send(q)) break;
      _wired.add(q.opId);
    }
  }

  void _change(CommentOp op) {
    _queue.ops.add(
      ClientMessageCommentOp(opId: uuidV4(), sessionId: _session(), ops: [op]),
    );
    _queue.save();
    notifyListeners();
    flush();
  }

  /// [id]: a media comment's, chosen before its files were written to `/marks/<id>`. [images] with [genImages]: the
  /// generated frame first, as the desktop keeps them.
  Comment add(
    Anchor anchor,
    String text,
    QuickLabelId? label, {
    String? id,
    List<String>? images,
    int? genImages,
    List<VoiceClip>? voice,
  }) {
    final c = Comment(
      id: id ?? uuidV4(),
      anchor: anchor,
      text: text,
      label: label,
      status: CommentStatus.pending,
      createdAt: _now().millisecondsSinceEpoch,
      images: images,
      genImages: genImages,
      voice: voice == null || voice.isEmpty ? null : voice,
    );
    _change(CommentOpAdd(comment: c));
    return c;
  }

  Comment _with(
    Comment c,
    String text,
    QuickLabelId? label,
    List<VoiceClip>? voice,
    List<String>? pasted,
  ) => Comment(
    id: c.id,
    anchor: c.anchor,
    text: text,
    label: label,
    status: c.status,
    createdAt: c.createdAt,
    sentIn: c.sentIn,
    // the generated frame stays first; the pasted images are what the sheet gives back
    images: pasted == null
        ? c.images
        : _orNone([...?c.images?.take(generatedImages(c)), ...pasted]),
    genImages: c.genImages,
    voice: voice == null || voice.isEmpty ? null : voice,
  );

  /// [voice] replaces the clips of the comment, [images] its pasted images: the sheet gives back all it has.
  void edit(
    String id,
    String text,
    QuickLabelId? label, {
    List<VoiceClip>? voice,
    List<String>? images,
  }) {
    final c = all.where((c) => c.id == id).firstOrNull;
    if (c == null) return;
    _change(CommentOpEdit(comment: _with(c, text, label, voice, images)));
  }

  /// [c] back where it was in [all] (index [at]), as the Undo of a deletion: with its text, images and state. The
  /// window takes it back even though it was deleted (`restore`).
  void restore(Comment c, int at) {
    // one that went out meanwhile would be sent twice
    if (_sending.contains(c.id)) return;
    final now = all;
    if (now.any((x) => x.id == c.id)) return;
    final i = at.clamp(0, now.length);
    _change(
      CommentOpAdd(
        comment: c,
        before: i < now.length ? now[i].id : null,
        restore: true,
      ),
    );
  }

  void remove(String id) => _change(CommentOpRemove(id: id));
}

List<String>? _orNone(List<String> l) => l.isEmpty ? null : l;

String _file(String path, String? ref) => ref == null ? path : '$path @ $ref';

/// Where a comment's fragment lives, as the desktop's `whereOf` names it: a file as its path (`path @ ref` from another
/// branch), a media mark with its time and size; a chat fragment as the desktop's plain name for it (my message, reply, or chat for one the feed no longer holds).
String whereOf(Comment c, Feed feed, String lang) => switch (c.anchor) {
  MediaAnchor(:final source, :final time, :final width, :final height) =>
    '${_file(source.path, source.ref)}${time != null ? ' @ ${mediaTime(time.toDouble())}' : ''} · ${jsNum(width)}×${jsNum(height)}',
  TextAnchor(source: AnchorSourceFile(:final path, :final ref)) => _file(
    path,
    ref,
  ),
  TextAnchor(source: AnchorSourceMessage(:final id, :final agent)) =>
    whereOfChat(id, feed, lang, agent: agent),
  _ => batchString('srcChat', lang),
};

/// What a comment is on, for the strip and the sheet: the quoted text, or a media file's name with the paused time.
String quoteOf(Comment c) => switch (c.anchor) {
  TextAnchor(:final quote) => quote,
  MediaAnchor(:final source, :final time) =>
    '${source.path.split('/').last}${time != null ? ' @ ${mediaTime(time.toDouble())}' : ''}',
  _ => '',
};

/// `👍 Looks good` in [lang], or '' without a quick label.
String labelLine(QuickLabelId? id, String lang) {
  final l = quickLabels.where((l) => l.id == id).firstOrNull;
  return l == null ? '' : '${l.emoji} ${l.textIn(lang)}';
}

/// How many leading images of a comment the app generated (`generatedImages`): a media one's frame (2 in old comments,
/// the frame and its layer); the rest were pasted.
int generatedImages(Comment c) =>
    c.anchor is MediaAnchor ? (c.genImages ?? 2).toInt() : 0;

/// The text sent to the agent and the images that go with it (compose.ts and send.ts's `sendNow`): [general], then the
/// numbered comments. The images are numbered across the message, each comment's own in turn (a media comment's frame,
/// then its pasted ones), and labelled as the desktop labels them; their type is the server's to know (it reads its own
/// store), so png stands in. [own] are the composer's images: they go first, labelled by position as `imgLabel`, and
/// the comments' numbering goes on after them. The phone does not combine the frames of comments on one frame into one
/// picture: each sends its own, the desktop's fallback.
({String text, List<ImageRef> images}) composeSend(
  String general,
  List<Comment> items,
  Feed feed,
  String lang, {
  bool Function(Comment)? staleOf,
  List<ImageRef> own = const [],
}) {
  final images = [
    for (final (k, im) in own.indexed)
      ImageRef(
        id: im.id,
        mediaType: im.mediaType,
        label: batchTemplate('imgLabel', lang, [k + 1]),
      ),
  ];
  if (items.isEmpty) return (text: general, images: images);
  final blocks = [
    for (final (i, c) in items.indexed)
      () {
        final all = c.images ?? const <String>[], gen = generatedImages(c);
        final refs = [
          for (final id in [...all.take(gen < 1 ? gen : 1), ...all.skip(gen)])
            () {
              images.add(
                ImageRef(
                  id: id,
                  mediaType: ImageType.image_png,
                  label: batchTemplate('imgLabelC', lang, [
                    images.length + 1,
                    i + 1,
                  ]),
                ),
              );
              return images.length;
            }(),
        ];
        final a = c.anchor;
        final quote = switch (a) {
          MediaAnchor(:final shapes, :final width, :final height) =>
            shapes
                .map(
                  (s) => '> ${describeShape(s, width.toInt(), height.toInt())}',
                )
                .join('\n'),
          TextAnchor(:final quote) =>
            quote.split('\n').map((l) => '> $l').join('\n'),
          _ => '',
        };
        var tail = '';
        if (a is MediaAnchor) {
          final sfx = a.scale != null
              ? batchTemplate('scaledSfx', lang, [jsNum(a.scale!)])
              : '';
          final dir = '.nota-bene/marks/${c.id}';
          if (refs.isNotEmpty) {
            tail +=
                '\n${batchTemplate('imgRefMedia', lang, [refs.first])}${refs.skip(1).map((k) => ', $k').join()}';
          }
          tail +=
              '\n${batchTemplate('filesLine', lang, ['$dir/frame.jpg$sfx, $dir/layer.png$sfx'])}';
          if (staleOf?.call(c) ?? false) {
            tail += '\n${batchString('markStale', lang)}';
          }
        } else if (refs.isNotEmpty) {
          tail = '\n${batchTemplate('imgRef', lang, [refs.join(', ')])}';
        }
        // the recordings' transcripts follow what was typed, each on a line of its own (a transcript's breaks are
        // spaces); the first of the lot is on the arrow line (compose.ts)
        final clips = [
          for (final v in c.voice ?? const <VoiceClip>[])
            v.text.replaceAll(RegExp(r'\s+'), ' ').trim(),
        ];
        final lines = [
          [
            labelLine(c.label, lang),
            c.text.trim(),
          ].where((s) => s.isNotEmpty).join(' '),
          ...clips,
        ].where((s) => s.isNotEmpty).toList();
        final body = lines.isEmpty ? '' : lines.first;
        final more = lines.skip(1).map((l) => '\n   $l').join();
        final instr = quickLabels
            .where((l) => l.id == c.label)
            .firstOrNull
            ?.instruction;
        return '${i + 1}. [${whereOf(c, feed, lang)}]\n$quote\n→ $body$more${instr != null ? '\n   $instr' : ''}$tail';
      }(),
  ];
  return (
    text:
        '${general.isNotEmpty ? '$general\n\n' : ''}${batchString('batchHead', lang)}\n\n${blocks.join('\n\n')}',
    images: images,
  );
}

/// The batch text alone.
String composeBatch(
  String general,
  List<Comment> items,
  String lang, [
  Feed? feed,
]) => composeSend(general, items, feed ?? Feed(), lang).text;
