// The window's comments as a pane, like the desktop's Comments tab: the pending ones on top with Send (the pending
// batch alone, as the composer's Send does with an empty field), the sent ones below, folded until their heading is
// tapped, grouped by the message they went with. A tap goes to the comment's place (a file opens, a chat comment scrolls the chat to its message); a long press
// on a pending one edits or deletes it.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/feed.dart';
import '../chat/files.dart';
import '../chat/send_now.dart';
import '../chat/window_tab.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/insets.dart';
import '../ui/nb_icon.dart';
import 'comment_strip.dart' show editComment;
import 'comments.dart';
import 'strings.g.dart';
import 'swipe_delete.dart';

class CommentsPane extends StatefulWidget {
  const CommentsPane({
    super.key,
    required this.tab,
    required this.onChat,
    this.topInset = 0,
  });
  final WindowTab tab;

  /// A comment on a chat message was tapped: show the chat at message [id].
  final void Function(String id) onChat;
  final double topInset;

  @override
  State<CommentsPane> createState() => _CommentsPaneState();
}

class _CommentsPaneState extends State<CommentsPane>
    with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  WindowTab get tab => widget.tab;

  // the sent ones are history: folded until asked for
  bool _sentOpen = false;

  void _go(Comment x) {
    switch (x.anchor) {
      case TextAnchor(source: AnchorSourceMessage(:final id)):
        widget.onChat(id);
      case TextAnchor(source: AnchorSourceFile(:final path)):
        openFile(context, tab, path);
      case MediaAnchor(:final source, :final time):
        openFile(context, tab, source.path, at: time?.toDouble());
      default:
    }
  }

  Widget _row(Comment x, String lang, NbColors c, {required bool pending}) {
    final label = labelLine(x.label, lang);
    final body = [
      if (label.isNotEmpty) label,
      x.text,
      for (final v in x.voice ?? const <VoiceClip>[]) v.text,
    ].where((s) => s.isNotEmpty).join(' ');
    final row = InkWell(
      onTap: () => _go(x),
      onLongPress: pending ? () => editComment(context, tab, x) : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              whereOf(x, tab.feed, lang),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: c.mutedFg, fontSize: 11),
            ),
            if (quoteOf(x).isNotEmpty)
              Container(
                margin: const EdgeInsets.only(top: 2),
                padding: const EdgeInsets.only(left: 8),
                decoration: BoxDecoration(
                  border: Border(left: BorderSide(color: c.accent, width: 2)),
                ),
                child: Text(
                  quoteOf(x),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: c.mutedFg, fontSize: 13),
                ),
              ),
            if (body.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  '→ $body',
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14),
                ),
              ),
          ],
        ),
      ),
    );
    // one that went out with a message waits for the server's answer: deleting it now could be undone into a second send
    if (!pending || tab.comments.isSending(x.id)) return row;
    // a swipe left deletes a pending one, and a snackbar brings it back
    return SwipeDelete(
      key: ValueKey('swipe:${x.id}'),
      background: Container(
        color: c.destructive,
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: const NbIcon(NbGlyph.trash, color: Colors.white),
      ),
      onDeleted: () => _delete(x),
      child: row,
    );
  }

  void _delete(Comment x) {
    final at = tab.comments.all.indexWhere((c) => c.id == x.id);
    tab.comments.remove(x.id);
    final t = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    messenger.clearSnackBars();
    final shown = _undo = messenger.showSnackBar(
      SnackBar(
        content: Text(t.commentDeleted),
        action: SnackBarAction(
          label: t.markUndo,
          onPressed: () => tab.comments.restore(x, at < 0 ? 0 : at),
        ),
      ),
    );
    // the Undo has no place to go once the pane is: it is taken away with it
    unawaited(
      shown.closed.then((_) {
        if (_undo == shown) _undo = null;
      }),
    );
  }

  ScaffoldFeatureController<SnackBar, SnackBarClosedReason>? _undo;

  @override
  void dispose() {
    _undo?.close();
    super.dispose();
  }

  /// A sent comment's group: the message it went with, as its first words.
  String _groupName(String id, AppLocalizations t, String lang) {
    for (final it in tab.feed.items) {
      if (it is UserItem && it.id == id) {
        final line = it.shownText
            .split('\n')
            .firstWhere((l) => l.trim().isNotEmpty, orElse: () => '')
            .trim();
        if (line.isNotEmpty) return line;
        break;
      }
    }
    return webString('srcMine', lang);
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    return Scaffold(
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: ListenableBuilder(
        listenable: Listenable.merge([tab, tab.comments]),
        builder: (context, _) {
          final all = tab.comments.all;
          final pending = tab.comments.pending;
          final sent = [
            for (final x in all)
              if (x.status == CommentStatus.sent) x,
          ];
          if (pending.isEmpty && sent.isEmpty) {
            return Center(
              child: Padding(
                padding: EdgeInsets.fromLTRB(24, 24 + widget.topInset, 24, 24),
                child: Text(t.noCommentsYet, textAlign: TextAlign.center),
              ),
            );
          }
          // the sent ones by the message they went with, the newest message first
          final order = <String>[];
          final groups = <String, List<Comment>>{};
          for (final x in sent.reversed) {
            final key = x.sentIn ?? '';
            if (!groups.containsKey(key)) order.add(key);
            (groups[key] ??= []).add(x);
          }
          final head = TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w600,
            color: c.mutedFg,
          );
          return ListView(
            // the list runs under the floating header and starts below it
            padding: EdgeInsets.only(
              top: widget.topInset,
              bottom: bottomRoom(context),
            ),
            children: [
              // the count is the strip's: what there is to send, not what a voice message holds
              if (pending.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 12, 0),
                  child: Row(
                    children: [
                      Expanded(
                        child: tab.comments.toSend == 0
                            ? const SizedBox.shrink()
                            : Text(
                                t.pendingComments(tab.comments.toSend),
                                style: head.copyWith(color: c.accent),
                              ),
                      ),
                      FilledButton(
                        onPressed:
                            tab.state == TabState.open &&
                                tab.comments.toSend > 0
                            ? () => sendPendingComments(context, tab)
                            : null,
                        child: Text(t.send),
                      ),
                    ],
                  ),
                ),
              for (final x in pending) _row(x, lang, c, pending: true),
              if (sent.isNotEmpty) ...[
                if (pending.isNotEmpty) const Divider(height: 24),
                InkWell(
                  key: const ValueKey('sent-fold'),
                  onTap: () => setState(() => _sentOpen = !_sentOpen),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            '${t.sentComments} · ${sent.length}',
                            style: head,
                          ),
                        ),
                        Icon(
                          _sentOpen ? Icons.expand_less : Icons.expand_more,
                          size: 18,
                          color: c.mutedFg,
                        ),
                      ],
                    ),
                  ),
                ),
                if (_sentOpen)
                  for (final key in order) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                      child: Text(
                        _groupName(key, t, lang),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: c.foreground,
                          fontWeight: FontWeight.w600,
                          fontSize: 13,
                        ),
                      ),
                    ),
                    for (final x in groups[key]!.reversed)
                      _row(x, lang, c, pending: false),
                  ],
              ],
            ],
          );
        },
      ),
    );
  }
}
