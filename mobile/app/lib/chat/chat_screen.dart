// One window's chat: the floating header pill (session, model, limits), a state line, the feed (newest at the bottom), and below it
// whatever the caller puts there (the composer).
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart' show StopReason;

import '../hosts/hosts_screen.dart';
import '../l10n/app_localizations.dart';
import '../comments/chat_anchor.dart';
import '../files/file_markdown.dart';
import '../theme.dart';
import 'chat_header.dart';
import 'comment_target.dart';
import 'feed.dart';
import 'files.dart';
import 'markdown.dart';
import 'message_menu.dart';
import 'message_selection.dart';
import 'window_tab.dart';

class ChatScreen extends StatelessWidget {
  const ChatScreen({
    super.key,
    required this.tab,
    this.bottom,
    this.actions = const [],
    this.overlay,
    this.itemBuilder,
    this.onTapTitle,
    this.onReply,
  });

  final WindowTab tab;
  final Widget? bottom;
  final List<Widget> actions;

  /// Tapping the header pill (the settings sheet, #143); null leaves the pill inert.
  final VoidCallback? onTapTitle;

  /// Covers the feed (the one-tab rule's Work here).
  final Widget? overlay;

  /// Reply in a message's menu: puts [quote] into the draft; null drops the entry's effect.
  final void Function(String quote)? onReply;

  /// Overrides the default look of an item (Task 10 answers permissions in the feed); null falls back.
  final Widget? Function(BuildContext, FeedItem)? itemBuilder;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: tab,
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final f = tab.feed;
      final status = _status(t);
      final items = f.items;
      // the feed keeps the floating header clear
      final top = MediaQuery.paddingOf(context).top + ChatHeader.extent;
      return Scaffold(
        body: SafeArea(
          top: false,
          child: FileOpener(
            tab: tab,
            child: Stack(
              children: [
                Column(
                  children: [
                    if (status != null)
                      Container(
                        width: double.infinity,
                        color: c.muted,
                        padding: EdgeInsets.fromLTRB(12, top + 6, 12, 6),
                        child: Text(
                          status,
                          style: TextStyle(color: c.mutedFg, fontSize: 13),
                        ),
                      ),
                    Expanded(
                      child: Stack(
                        children: [
                          // reversed: the newest item sits at the bottom and stays in view while the user is there
                          ListView.builder(
                            reverse: true,
                            padding: EdgeInsets.fromLTRB(
                              12,
                              status == null ? top : 8,
                              12,
                              8,
                            ),
                            itemCount: items.length + (f.earlier > 0 ? 1 : 0),
                            itemBuilder: (context, i) {
                              if (i == items.length) {
                                return Center(
                                  child: TextButton(
                                    onPressed: tab.loadEarlier,
                                    child: Text(t.showEarlier),
                                  ),
                                );
                              }
                              final it = items[items.length - 1 - i];
                              // keyed by the item, not the index: a new item shifts every index of a reversed list
                              return KeyedSubtree(
                                key: ValueKey(feedKey(it)),
                                child: _Commentable(
                                  tab: tab,
                                  item: it,
                                  onReply: onReply ?? (_) {},
                                  child:
                                      itemBuilder?.call(context, it) ??
                                      FeedItemView(it),
                                ),
                              );
                            },
                            findChildIndexCallback: (key) {
                              final k = (key as ValueKey<String>).value;
                              final at = items.lastIndexWhere(
                                (it) => feedKey(it) == k,
                              );
                              return at < 0 ? null : items.length - 1 - at;
                            },
                          ),
                          if (f.compacting)
                            Positioned(
                              left: 0,
                              right: 0,
                              bottom: 0,
                              child: LinearProgressIndicator(
                                minHeight: 2,
                                color: c.accent,
                              ),
                            ),
                          ?overlay,
                        ],
                      ),
                    ),
                    ?bottom,
                  ],
                ),
                Positioned(
                  top: 0,
                  left: 0,
                  right: 0,
                  child: SafeArea(
                    bottom: false,
                    child: ChatHeader(
                      tab: tab,
                      onTapTitle: onTapTitle,
                      actions: actions,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );

  String? _status(AppLocalizations t) {
    final l = tab.link;
    return switch (tab.state) {
      TabState.open => tab.busy ? t.working : null,
      TabState.connecting => t.connecting,
      TabState.offline =>
        l.lastSeen == null
            ? t.offline
            : t.offlineSeen(ago(t, DateTime.now().difference(l.lastSeen!))),
      TabState.gone => t.windowGone,
      TabState.occupied || TabState.taken => null,
    };
  }
}

/// A long press on a commentable item (a user message, a final reply) opens its menu; others pass through. "Select
/// text" in the menu puts this one item into selection mode until a tap lands outside it.
class _Commentable extends StatefulWidget {
  const _Commentable({
    required this.tab,
    required this.item,
    required this.onReply,
    required this.child,
  });
  final WindowTab tab;
  final FeedItem item;
  final void Function(String quote) onReply;
  final Widget child;

  @override
  State<_Commentable> createState() => _CommentableState();
}

class _CommentableState extends State<_Commentable> {
  bool _selecting = false;
  Offset? _from;

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    if (chatSource(item) == null) return widget.child;
    if (_selecting) {
      return CommentTarget(
        tab: widget.tab,
        item: item,
        child: SelectableMessage(
          tab: widget.tab,
          item: item,
          from: _from,
          onDone: () => setState(() => _selecting = false),
        ),
      );
    }
    return CommentTarget(
      tab: widget.tab,
      item: item,
      child: GestureDetector(
        onLongPressStart: (d) {
          final at = d.globalPosition;
          final box = context.findRenderObject() as RenderBox;
          final rect = box.localToGlobal(Offset.zero) & box.size;
          showMessageMenu(
            context,
            tab: widget.tab,
            item: item,
            itemRect: rect,
            onSelectText: () => setState(() {
              _selecting = true;
              _from = at;
            }),
            onReply: widget.onReply,
          );
        },
        child: widget.child,
      ),
    );
  }
}

/// The default look of one feed item.
class FeedItemView extends StatelessWidget {
  const FeedItemView(this.item, {super.key, this.listenerAt});
  final FeedItem item;

  /// In selection mode: the Markdown is drawn block by block, each block's selection reported to its notifier.
  final SelectionListenerNotifier Function(int block)? listenerAt;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    Widget line(String text, {Color? color}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Text(
        text,
        style: TextStyle(color: color ?? c.mutedFg, fontSize: 13),
      ),
    );
    return switch (item) {
      UserItem(:final text, :final idle) =>
        idle
            ? line(t.idleCompact)
            : Align(
                alignment: Alignment.centerRight,
                child: LayoutBuilder(
                  builder: (context, box) => Container(
                    key: const ValueKey('bubble'),
                    margin: const EdgeInsets.symmetric(vertical: 6),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 7,
                    ),
                    constraints: BoxConstraints(maxWidth: box.maxWidth * .84),
                    decoration: BoxDecoration(
                      color: Color.alphaBlend(
                        c.primary.withValues(alpha: .28),
                        c.background,
                      ),
                      borderRadius: const BorderRadius.only(
                        topLeft: Radius.circular(14),
                        topRight: Radius.circular(14),
                        bottomLeft: Radius.circular(14),
                        bottomRight: Radius.circular(4),
                      ),
                      border: Border.all(
                        color: c.primary.withValues(alpha: .45),
                      ),
                    ),
                    // as the desktop shows it, and as chatText reads it: Markdown with breaks, HTML as text
                    child: listenerAt == null
                        ? NbMarkdown(
                            userMarkdownSource(text),
                            blockSyntaxes: userBlockSyntaxes,
                            inlineSyntaxes: userInlineSyntaxes,
                            softLineBreak: true,
                          )
                        : FileMarkdown(
                            text: text,
                            listenerAt: listenerAt!,
                            parse: parseUserMessage,
                            softLineBreak: true,
                          ),
                  ),
                ),
              ),
      AssistantItem(:final text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: listenerAt == null
            ? NbMarkdown(text)
            : FileMarkdown(text: text, listenerAt: listenerAt!),
      ),
      ToolItem() => ToolLine(item as ToolItem),
      DoneItem(:final secs, :final status, :final error) => line(
        switch (status) {
          StopReason.interrupted => t.turnInterrupted(duration(t, secs)),
          StopReason.failed => t.turnFailed(duration(t, secs), error ?? ''),
          _ => t.turnDone(duration(t, secs)),
        },
      ),
      MarkerItem(:final what, :final error) => line(switch (what) {
        MarkerKind.compacted => t.markerCompacted,
        MarkerKind.compactFailed => t.markerCompactFailed(error ?? ''),
        MarkerKind.cleared => t.markerCleared,
      }),
      PermissionItem(:final toolName, :final answer) => line(
        answer == null
            ? t.permissionAsked(toolName)
            : (answer ? t.allowed : t.denied),
        color: answer == null ? c.accent : null,
      ),
      ShellItem(:final cmd, :final output) => Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: c.codeBg,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: c.border),
        ),
        child: Text(
          '! $cmd\n$output',
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
        ),
      ),
      NoticeItem(:final text) => line(t.resumed(text)),
    };
  }
}

String duration(AppLocalizations t, num secs) => secs < 60
    ? t.durationSecs(secs.round())
    : t.durationMins(secs ~/ 60, (secs % 60).round());

/// A tool call as one line (name and its main argument); its result opens on tap.
class ToolLine extends StatefulWidget {
  const ToolLine(this.item, {super.key});
  final ToolItem item;

  @override
  State<ToolLine> createState() => _ToolLineState();
}

class _ToolLineState extends State<ToolLine> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final it = widget.item;
    final running = it.result == null;
    // a file of the project the phone opens (Markdown, an image, a video) opens over the chat
    final tab = FileOpener.of(context);
    final path = toolPath(it);
    final file = tab == null || path == null
        ? null
        : projectFile(tab.root, path);
    return Padding(
      padding: EdgeInsets.only(left: it.sub ? 16 : 0, top: 2, bottom: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: running ? null : () => setState(() => _open = !_open),
            child: Row(
              children: [
                Icon(
                  running
                      ? Icons.more_horiz
                      : (it.isError ? Icons.error_outline : Icons.check),
                  size: 14,
                  color: it.isError ? c.destructive : c.mutedFg,
                ),
                const SizedBox(width: 6),
                Text(it.name, style: TextStyle(color: c.accent, fontSize: 13)),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    it.arg,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12,
                      color: c.mutedFg,
                    ),
                  ),
                ),
                if (file != null)
                  IconButton(
                    tooltip: AppLocalizations.of(context).openFile,
                    visualDensity: VisualDensity.compact,
                    iconSize: 18,
                    icon: Icon(fileIcon(file), color: c.link),
                    onPressed: () => openFile(context, tab!, file),
                  ),
              ],
            ),
          ),
          if (_open && it.result != null)
            Container(
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.all(8),
              constraints: const BoxConstraints(maxHeight: 320),
              decoration: BoxDecoration(
                color: c.codeBg,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: c.border),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  it.result!,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
