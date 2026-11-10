// Consecutive actions as one folded line, "▸ 3 actions · 1 error · 2 comments": a port of web/src/feed/ToolGroup.tsx.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart'
    show AnchorSourceMessage, TextAnchor;

import '../comments/comments.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'chat_screen.dart' show ToolLine;
import 'feed.dart';
import 'files.dart';
import 'media_card.dart';

/// The comments on the action [toolId] of the chat itself (pending and sent): the web's `selectToolCommentCounts`.
int toolComments(Comments comments, String toolId) {
  var n = 0;
  for (final c in comments.all) {
    if (c.anchor case TextAnchor(
      source: AnchorSourceMessage(:final id, :final agent),
    ) when (agent == null || agent.isEmpty) && id == 'tool:$toolId') {
      n++;
    }
  }
  return n;
}

/// The group's head and, below it, either every action (open) or, while the turn still runs and this is the last
/// thing in the feed ([live]), the latest one. A failed action of an open group shows its output unasked.
class ToolGroup extends StatefulWidget {
  const ToolGroup({
    super.key,
    required this.items,
    required this.live,
    this.targetOf,
  });
  final List<ToolItem> items;
  final bool live;

  /// The key a jump to an action scrolls by; null for none.
  final GlobalKey? Function(ToolItem)? targetOf;

  @override
  State<ToolGroup> createState() => _ToolGroupState();
}

class _ToolGroupState extends State<ToolGroup> {
  final _local = FeedUi();
  Comments? _watching;

  FeedUi _ui(BuildContext context) => FileOpener.of(context)?.feedUi ?? _local;

  void _watch(Comments? c) {
    if (_watching == c) return;
    _watching?.removeListener(_changed);
    _watching = c?..addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _watching?.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final tab = FileOpener.of(context);
    _watch(tab?.comments);
    final ui = _ui(context);
    final items = widget.items;
    final first = items.first.id;
    final open = ui.groupOpen(first);
    final errors = items.where((i) => i.result != null && i.isError).length;
    final comments = tab == null
        ? 0
        : items.fold(0, (n, i) => n + toolComments(tab.comments, i.id));
    final head = TextStyle(
      fontFamily: 'monospace',
      fontSize: 12,
      color: c.mutedFg,
    );
    Widget line(ToolItem i, {required bool inGroup}) => KeyedSubtree(
      key: widget.targetOf?.call(i),
      // folded, the head's own cards show the pictures
      child: ToolLine(i, inGroup: inGroup, media: inGroup),
    );
    // folded, the pictures of the actions stay in view: the last three, the newest at the bottom
    final cards = open || tab == null
        ? const <MediaSpec>[]
        : [
            for (final i in items) ...mediaOf(tab, i),
          ].reversed.take(3).toList().reversed.toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          button: true,
          expanded: open,
          child: InkWell(
            onTap: () => setState(() => ui.toggleGroup(first)),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 40),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text.rich(
                  key: const ValueKey('group-head'),
                  TextSpan(
                    style: head,
                    children: [
                      // the glyph says nothing a screen reader needs: the button's state is `expanded`
                      TextSpan(text: open ? '▾ ' : '▸ '),
                      TextSpan(text: t.toolActions(items.length)),
                      if (errors > 0)
                        TextSpan(
                          text: ' · ${t.toolErrors(errors)}',
                          style: TextStyle(color: c.destructive),
                        ),
                      if (!open && comments > 0)
                        TextSpan(
                          text: ' · ${t.toolComments(comments)}',
                          style: TextStyle(color: c.accent),
                        ),
                    ],
                  ),
                  semanticsLabel: [
                    t.toolActions(items.length),
                    if (errors > 0) t.toolErrors(errors),
                    if (!open && comments > 0) t.toolComments(comments),
                  ].join(', '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ),
        ),
        if (!open)
          for (final m in cards) MediaCard(tab: tab!, spec: m),
        if (open)
          Container(
            margin: const EdgeInsets.only(left: 4),
            padding: const EdgeInsets.only(left: 8),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: c.borderSoft)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [for (final i in items) line(i, inGroup: true)],
            ),
          )
        else if (widget.live)
          Padding(
            padding: const EdgeInsets.only(left: 12),
            child: line(items.last, inGroup: false),
          ),
      ],
    );
  }
}
