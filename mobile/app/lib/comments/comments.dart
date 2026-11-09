// The window's comments, as the desktop keeps them: the server holds the set of the session (the `comments` event,
// on connect and after every change), a client sends the whole set back after a change (`comments` message), and a
// send with `commentIds` makes the server mark them sent. The batch text is the desktop's (web/src/comments/compose.ts).
import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart' show uuidV4;
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

  /// What the phone sends with a message: the pending text comments. A media or page comment made on the desktop
  /// stays pending for it (its frame images are the desktop's to attach).
  List<Comment> get sendable => [
    for (final c in pending)
      if (c.anchor is TextAnchor) c,
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
    for (final c in items) {
      _mine.remove(c.id);
    }
    notifyListeners();
  }

  void _push(List<Comment> next) {
    _send(ClientMessageComments(sessionId: _session(), items: next));
    notifyListeners();
  }

  Comment add(TextAnchor anchor, String text, QuickLabelId? label) {
    final c = Comment(
      id: uuidV4(),
      anchor: anchor,
      text: text,
      label: label,
      status: CommentStatus.pending,
      createdAt: _now().millisecondsSinceEpoch,
    );
    final next = [...all, c];
    _mine[c.id] = (c: c, at: _now());
    _push(next);
    return c;
  }

  Comment _with(Comment c, String text, QuickLabelId? label) => Comment(
    id: c.id,
    anchor: c.anchor,
    text: text,
    label: label,
    status: c.status,
    createdAt: c.createdAt,
    sentIn: c.sentIn,
    images: c.images,
    genImages: c.genImages,
  );

  void edit(String id, String text, QuickLabelId? label) {
    final next = [for (final c in all) c.id == id ? _with(c, text, label) : c];
    if (_mine.containsKey(id)) {
      _mine[id] = (c: next.firstWhere((c) => c.id == id), at: _now());
    }
    _server = [for (final c in _server) c.id == id ? _with(c, text, label) : c];
    _push(next);
  }

  void remove(String id) {
    _mine.remove(id);
    _server = [
      for (final c in _server)
        if (c.id != id) c,
    ];
    _push(_server);
  }
}

/// A file as its path (`path @ ref` from another branch); a chat fragment as "chat", since the phone does not number
/// the replies the way the desktop's batch does.
String _whereOf(Comment c, String lang) => switch (c.anchor) {
  TextAnchor(source: AnchorSourceFile(:final path, :final ref)) =>
    ref == null ? path : '$path @ $ref',
  _ => batchString('srcChat', lang),
};

/// `👍 Looks good` in [lang], or '' without a quick label.
String labelLine(QuickLabelId? id, String lang) {
  final l = quickLabels.where((l) => l.id == id).firstOrNull;
  return l == null ? '' : '${l.emoji} ${l.textIn(lang)}';
}

/// The text sent to the agent: [general], then the numbered comments (compose.ts, its text-anchor branch).
String composeBatch(String general, List<Comment> items, String lang) {
  if (items.isEmpty) return general;
  final blocks = [
    for (final (i, c) in items.indexed)
      () {
        final quote = switch (c.anchor) {
          TextAnchor(:final quote) =>
            quote.split('\n').map((l) => '> $l').join('\n'),
          _ => '',
        };
        final body = [
          labelLine(c.label, lang),
          c.text.trim(),
        ].where((s) => s.isNotEmpty).join(' ');
        final instr = quickLabels
            .where((l) => l.id == c.label)
            .firstOrNull
            ?.instruction;
        return '${i + 1}. [${_whereOf(c, lang)}]\n$quote\n→ $body${instr != null ? '\n   $instr' : ''}';
      }(),
  ];
  return '${general.isNotEmpty ? '$general\n\n' : ''}${batchString('batchHead', lang)}\n\n${blocks.join('\n\n')}';
}
