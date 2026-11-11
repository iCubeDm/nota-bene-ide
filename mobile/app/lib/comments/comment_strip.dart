// Above the composer: one line saying how many comments are waiting; a tap opens the Comments pane, where they are
// read, edited and sent.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'comment_sheet.dart';
import 'comments.dart';

/// The comment sheet over [x]: saving edits it, Delete removes it.
Future<void> editComment(BuildContext context, WindowTab tab, Comment x) async {
  final res = await showCommentSheet(
    context,
    quote: quoteOf(x),
    editing: x,
    tab: tab,
  );
  switch (res) {
    case SheetSave(:final text, :final label, :final voice, :final images):
      tab.comments.edit(x.id, text, label, voice: voice, images: images);
    case SheetDelete():
      tab.comments.remove(x.id);
    case null:
  }
}

class CommentStrip extends StatelessWidget {
  const CommentStrip({super.key, required this.tab, required this.onTap});
  final WindowTab tab;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: tab.comments,
    builder: (context, _) {
      final n = tab.comments.sendable.length;
      if (n == 0) return const SizedBox.shrink();
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final shape = RoundedRectangleBorder(
        side: BorderSide(color: c.border),
        borderRadius: BorderRadius.circular(8),
      );
      return Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
        // Material under the InkWell: the splash shows on the card, not behind it
        child: Semantics(
          button: true,
          child: Material(
            color: c.card,
            shape: shape,
            child: InkWell(
              customBorder: shape,
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                child: Text(
                  t.pendingComments(n),
                  style: TextStyle(color: c.accent, fontSize: 12),
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
}
