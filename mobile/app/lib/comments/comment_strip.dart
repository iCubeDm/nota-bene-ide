// Above the composer, as on the desktop: the comments that leave with the next message. Tap opens a file comment's
// file; long press offers to delete it.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/files.dart';
import '../chat/window_tab.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'comment_sheet.dart';
import 'comments.dart';

/// The comment sheet over [x]: saving edits it, Delete removes it.
Future<void> editComment(BuildContext context, WindowTab tab, Comment x) async {
  final res = await showCommentSheet(context, quote: quoteOf(x), editing: x);
  switch (res) {
    case SheetSave(:final text, :final label):
      tab.comments.edit(x.id, text, label);
    case SheetDelete():
      tab.comments.remove(x.id);
    case null:
  }
}

class CommentStrip extends StatelessWidget {
  const CommentStrip({super.key, required this.tab});
  final WindowTab tab;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: tab.comments,
    builder: (context, _) {
      final items = tab.comments.sendable;
      if (items.isEmpty) return const SizedBox.shrink();
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final lang = Localizations.localeOf(context).languageCode;
      return Container(
        constraints: const BoxConstraints(maxHeight: 132),
        margin: const EdgeInsets.fromLTRB(8, 4, 8, 0),
        decoration: BoxDecoration(
          color: c.card,
          border: Border.all(color: c.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 6, 10, 2),
              child: Text(
                t.pendingComments(items.length),
                style: TextStyle(color: c.accent, fontSize: 12),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 4),
                children: [for (final x in items) _row(context, x, lang, c)],
              ),
            ),
          ],
        ),
      );
    },
  );

  Widget _row(BuildContext context, Comment x, String lang, NbColors c) {
    final quote = quoteOf(x);
    final body = [
      labelLine(x.label, lang),
      x.text,
    ].where((s) => s.isNotEmpty).join(' ');
    final path = switch (x.anchor) {
      TextAnchor(source: AnchorSourceFile(:final path)) => path,
      MediaAnchor(:final source) => source.path,
      _ => null,
    };
    return InkWell(
      onTap: path == null
          ? null
          : () => openFile(
              context,
              tab,
              path,
              at: switch (x.anchor) {
                MediaAnchor(:final time) => time?.toDouble(),
                _ => null,
              },
            ),
      onLongPress: () => editComment(context, tab, x),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: '“$quote” ',
                style: TextStyle(color: c.mutedFg),
              ),
              TextSpan(text: body),
            ],
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 13),
        ),
      ),
    );
  }
}
