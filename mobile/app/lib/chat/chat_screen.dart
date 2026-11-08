// One window's chat: the folder and session in the bar, a state line, the feed (newest at the bottom), and below it
// whatever the caller puts there (the composer).
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart' show StopReason;

import '../hosts/hosts_screen.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'feed.dart';
import 'markdown.dart';
import 'window_tab.dart';

class ChatScreen extends StatelessWidget {
  const ChatScreen({
    super.key,
    required this.tab,
    this.bottom,
    this.actions = const [],
    this.overlay,
    this.itemBuilder,
  });

  final WindowTab tab;
  final Widget? bottom;
  final List<Widget> actions;

  /// Covers the feed (the one-tab rule's Work here).
  final Widget? overlay;

  /// Overrides the default look of an item (Task 10 answers permissions in the feed); null falls back.
  final Widget? Function(BuildContext, FeedItem)? itemBuilder;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: tab,
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final f = tab.feed;
      final sub = [
        f.title ?? t.untitled,
        if ((tab.model ?? f.model) != null) tab.model ?? f.model!,
      ].join(' · ');
      final status = _status(t);
      final items = f.items;
      return Scaffold(
        appBar: AppBar(
          titleSpacing: 0,
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(folderOf(tab.root)),
              Text(
                sub,
                style: TextStyle(fontSize: 12, color: c.mutedFg),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
          actions: actions,
        ),
        body: SafeArea(
          child: Column(
            children: [
              if (status != null)
                Container(
                  width: double.infinity,
                  color: c.muted,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
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
                      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
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
                          child:
                              itemBuilder?.call(context, it) ??
                              FeedItemView(it),
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

/// The default look of one feed item.
class FeedItemView extends StatelessWidget {
  const FeedItemView(this.item, {super.key});
  final FeedItem item;

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
                child: Container(
                  margin: const EdgeInsets.symmetric(vertical: 6),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  constraints: const BoxConstraints(maxWidth: 560),
                  decoration: BoxDecoration(
                    color: c.card,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: c.border),
                  ),
                  child: SelectableText(text),
                ),
              ),
      AssistantItem(:final text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: NbMarkdown(text),
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
