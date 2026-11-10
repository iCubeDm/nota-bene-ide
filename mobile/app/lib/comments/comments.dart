// The window's comments, as the desktop keeps them: the server holds the set of the session (the `comments` event,
// on connect and after every change), a client sends the whole set back after a change (`comments` message), and a
// send with `commentIds` makes the server mark them sent. The batch text is the desktop's (web/src/comments/compose.ts).
import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/feed.dart' show Feed;
import '../chat/window_tab.dart' show uuidV4;
import '../media/shapes.dart';
import 'chat_anchor.dart';
import 'strings.g.dart';

/// How long a comment added here is shown before the server's set has it (a broadcast from before ours can land first).
const _overlayFor = Duration(seconds: 5);

class Comments extends ChangeNotifier {
  Comments(this._send, this._session, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  final bool Function(ClientMessage) _send;
  final String? Function() _session;
  final DateTime Function() _now;

  List<Comment> _server = const [];

  /// added here, not yet in a set from the server: id -> (comment, when)
  final _mine = <String, ({Comment c, DateTime at})>{};

  List<Comment> get all {
    final now = _now();
    _mine.removeWhere((_, v) => now.difference(v.at) > _overlayFor);
    final have = {for (final c in _server) c.id};
    return [
      ..._server,
      for (final v in _mine.values)
        if (!have.contains(v.c.id)) v.c,
    ];
  }

  List<Comment> get pending => [
    for (final c in all)
      if (c.status == CommentStatus.pending) c,
  ];

  /// sent with a message the server has not answered yet
  final _sending = <String>{};

  /// What the phone sends with a message: the pending text and media comments, their images with them. A page
  /// comment or a 3D model one, made on the desktop, stays pending for it (the phone cannot write their batch lines).
  List<Comment> get sendable => [
    for (final c in pending)
      if (switch (c.anchor) {
            TextAnchor() => true,
            MediaAnchor(:final camera) => camera == null,
            _ => false,
          } &&
          !_sending.contains(c.id))
        c,
  ];

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

  /// The server's set. A comment of ours stops being overlaid once the server has had it.
  void apply(List<Comment> items) {
    _server = List.unmodifiable(items);
    _sending.clear();
    for (final c in items) {
      _mine.remove(c.id);
    }
    notifyListeners();
  }

  void _push(List<Comment> next) {
    _send(ClientMessageComments(sessionId: _session(), items: next));
    notifyListeners();
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
    final next = [...all, c];
    _mine[c.id] = (c: c, at: _now());
    _push(next);
    return c;
  }

  Comment _with(
    Comment c,
    String text,
    QuickLabelId? label,
    List<VoiceClip>? voice,
  ) => Comment(
    id: c.id,
    anchor: c.anchor,
    text: text,
    label: label,
    status: c.status,
    createdAt: c.createdAt,
    sentIn: c.sentIn,
    images: c.images,
    genImages: c.genImages,
    voice: voice == null || voice.isEmpty ? null : voice,
  );

  /// [voice] replaces the clips of the comment: the sheet gives back all it has.
  void edit(
    String id,
    String text,
    QuickLabelId? label, {
    List<VoiceClip>? voice,
  }) {
    final next = [
      for (final c in all) c.id == id ? _with(c, text, label, voice) : c,
    ];
    if (_mine.containsKey(id)) {
      _mine[id] = (c: next.firstWhere((c) => c.id == id), at: _now());
    }
    _server = [
      for (final c in _server) c.id == id ? _with(c, text, label, voice) : c,
    ];
    _push(next);
  }

  void remove(String id) {
    _mine.remove(id);
    _server = [
      for (final c in _server)
        if (c.id != id) c,
    ];
    _push(all);
  }
}

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
