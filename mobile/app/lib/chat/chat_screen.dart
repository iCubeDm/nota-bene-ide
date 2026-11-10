// One window's chat: the floating header pill (session, model, limits), a state line, the feed (newest at the bottom), and below it
// whatever the caller puts there (the composer).
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart'
    show AnchorSourceMessage, StopReason, TextAnchor;

import '../l10n/app_localizations.dart';
import '../comments/anchor.dart';
import '../comments/chat_anchor.dart';
import '../comments/comment_strip.dart' show editComment;
import '../files/file_markdown.dart';
import '../theme.dart';
import '../voice/outbox.dart';
import '../voice/upload.dart';
import '../voice/voice_bubble.dart';
import 'chat_header.dart';
import 'comment_target.dart';
import 'feed.dart';
import 'files.dart';
import 'media_card.dart';
import 'markdown.dart';
import 'message_menu.dart';
import 'message_selection.dart';
import 'sent_comments.dart';
import 'tool_group.dart';
import 'window_tab.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.tab,
    this.bottom,
    this.actions = const [],
    this.overlay,
    this.itemBuilder,
    this.onTapTitle,
    this.onTapRing,
    this.onReply,
    this.showHeader = true,
    this.extraTop = 0,
    this.focus,
  });

  final WindowTab tab;

  /// False when a host puts the header above several panes itself.
  final bool showHeader;

  /// Room kept clear above the feed besides the header (a strip of tabs under it).
  final double extraTop;

  /// Lets the host scroll the feed to a message.
  final ChatFocus? focus;
  final Widget? bottom;
  final List<Widget> actions;

  /// Tapping the header pill (the settings sheet, #143); null leaves the pill inert.
  final VoidCallback? onTapTitle;

  /// Tapping the context ring (the context sheet); null leaves it inert.
  final VoidCallback? onTapRing;

  /// Covers the feed (the one-tab rule's Work here).
  final Widget? overlay;

  /// Reply in a message's menu: puts [quote] into the draft; null drops the entry's effect.
  final void Function(String quote)? onReply;

  /// Overrides the default look of an item (Task 10 answers permissions in the feed); null falls back.
  final Widget? Function(BuildContext, FeedItem)? itemBuilder;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

/// Scrolls a chat's feed to a message from outside it (the comments pane).
class ChatFocus {
  Future<bool> Function(String messageId)? _go;

  /// Scrolls to the feed item of message [id] (a user message, a reply, a tool call); false when it is not in the feed.
  Future<bool> scrollTo(String id) => _go?.call(id) ?? Future.value(false);
}

class _ChatScreenState extends State<ChatScreen> {
  final _scroll = ScrollController();
  final _targets = <String, GlobalKey>{};

  @override
  void initState() {
    super.initState();
    widget.focus?._go = _scrollTo;
  }

  @override
  void didUpdateWidget(ChatScreen old) {
    super.didUpdateWidget(old);
    if (old.focus != widget.focus) {
      old.focus?._go = null;
      widget.focus?._go = _scrollTo;
    }
  }

  @override
  void dispose() {
    if (widget.focus?._go == _scrollTo) widget.focus?._go = null;
    _scroll.dispose();
    super.dispose();
  }

  /// The feed key of the item message [id] names, or null.
  String? _keyOf(String id) {
    for (final it in widget.tab.feed.items) {
      final k = feedKey(it);
      if (k == 'user:$id' ||
          k == 'assistant:$id' ||
          k == id ||
          (id.startsWith('tool:') && k == id) ||
          (id.startsWith('plan:') && k == 'permission:${id.substring(5)}')) {
        return k;
      }
    }
    return null;
  }

  /// The feed is a lazy list: the item is built only near the screen. Jump near its place by the average height of an
  /// item, then step toward it until it is built, and bring it into view.
  Future<bool> _scrollTo(String id) async {
    final key = _keyOf(id);
    if (key == null || !_scroll.hasClients) return false;
    final rows = feedRows(widget.tab.feed.items);
    final at = rows.indexWhere((r) => r.items.any((it) => feedKey(it) == key));
    if (at < 0) return false;
    final row = rows[at];
    final fromEnd = rows.length - 1 - at;
    // the action's output opens with it, and its group when it has one
    final isTool = key.startsWith('tool:');
    final inner = isTool && row.isGroup ? key : null;
    if (isTool) {
      widget.tab.feedUi.reveal(
        key.substring(5),
        group: row.isGroup ? (row.items.first as ToolItem).id : null,
      );
    }
    // an item that is built already gets its key only on a rebuild
    final fresh =
        !_targets.containsKey(row.key) ||
        (inner != null && !_targets.containsKey(inner));
    final target = _targets.putIfAbsent(row.key, GlobalKey.new);
    final innerTarget = inner == null
        ? null
        : _targets.putIfAbsent(inner, GlobalKey.new);
    if (fresh || isTool) setState(() {});
    final pos = _scroll.position;
    final avg = (pos.maxScrollExtent + pos.viewportDimension) / rows.length;
    // the reversed list: offset 0 is the newest
    _scroll.jumpTo((fromEnd * avg).clamp(0.0, pos.maxScrollExtent));
    for (var i = 0; i < 40; i++) {
      await WidgetsBinding.instance.endOfFrame;
      if (!mounted) return false;
      if (target.currentContext != null) {
        await Scrollable.ensureVisible(
          innerTarget?.currentContext ?? target.currentContext!,
          alignment: .3,
          duration: const Duration(milliseconds: 250),
        );
        return true;
      }
      // not built: find which side it is on by the keyed neighbours the feed builds
      final here = _scroll.position;
      final up = _builtBeyond(fromEnd, rows);
      final step = here.viewportDimension * .8;
      final next = (here.pixels + (up ? -step : step)).clamp(
        0.0,
        here.maxScrollExtent,
      );
      if (next == here.pixels) break;
      _scroll.jumpTo(next);
    }
    return false;
  }

  /// Whether the items built now are all older than item [fromEnd] counted from the newest (so the item is below).
  bool _builtBeyond(int fromEnd, List<FeedRow> rows) {
    final built = <int>[];
    final seen = <String>{};
    void visit(Element e) {
      final k = e.widget.key;
      if (k is ValueKey<String> && seen.add(k.value)) {
        final i = rows.indexWhere((r) => r.key == k.value);
        if (i >= 0) built.add(rows.length - 1 - i);
      }
      e.visitChildren(visit);
    }

    context.visitChildElements(visit);
    if (built.isEmpty) return false;
    return built.reduce((a, b) => a < b ? a : b) > fromEnd;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.tab, widget.tab.voiceOutbox]),
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final f = widget.tab.feed;
      final pending = widget.tab.voiceOutbox.entries;
      final items = f.items;
      final rows = feedRows(items);
      // the feed keeps the floating header clear
      final top =
          MediaQuery.paddingOf(context).top +
          (widget.showHeader ? ChatHeader.extent : 0) +
          widget.extraTop;
      return Scaffold(
        body: SafeArea(
          top: false,
          child: FileOpener(
            tab: widget.tab,
            child: Stack(
              children: [
                Column(
                  children: [
                    Expanded(
                      child: Stack(
                        children: [
                          // reversed: the newest item sits at the widget.bottom and stays in view while the user is there
                          ListView.builder(
                            controller: _scroll,
                            reverse: true,
                            // full width: the bubbles keep their own margins
                            padding: EdgeInsets.fromLTRB(
                              0,
                              top,
                              0,
                              // the floating Stop must not cover the end of the last bubble
                              widget.tab.state == TabState.open &&
                                      widget.tab.busy
                                  ? 8 + 56
                                  : 8,
                            ),
                            itemCount:
                                rows.length +
                                pending.length +
                                (f.earlier > 0 ? 1 : 0),
                            itemBuilder: (context, i) {
                              // the newest sit at the bottom: the recordings still going out
                              if (i < pending.length) {
                                final e = pending[pending.length - 1 - i];
                                return PendingVoiceBubble(
                                  e,
                                  widget.tab.voiceOutbox,
                                  key: ValueKey(e.key),
                                );
                              }
                              i -= pending.length;
                              if (i == rows.length) {
                                return Center(
                                  child: TextButton(
                                    onPressed: widget.tab.loadEarlier,
                                    child: Text(t.showEarlier),
                                  ),
                                );
                              }
                              final at = rows.length - 1 - i;
                              final row = rows[at];
                              final it = row.items.first;
                              final inner = row.isGroup
                                  ? ToolGroup(
                                      items: row.items.cast<ToolItem>(),
                                      live: f.busy && row.end == items.length,
                                      targetOf: (t) => _targets[feedKey(t)],
                                    )
                                  : _Commentable(
                                      tab: widget.tab,
                                      item: it,
                                      onReply: widget.onReply ?? (_) {},
                                      child:
                                          widget.itemBuilder?.call(
                                            context,
                                            it,
                                          ) ??
                                          (chatSource(it) == null
                                              ? FeedItemView(it)
                                              : _Marked(
                                                  tab: widget.tab,
                                                  item: it,
                                                )),
                                    );
                              // keyed by the row, not the index: a new item shifts every index of a reversed list
                              return KeyedSubtree(
                                key: ValueKey(row.key),
                                // the agent's turn is one bubble: its items are the pieces of it
                                child: KeyedSubtree(
                                  key: _targets[row.key],
                                  child: inAgentTurn(it)
                                      ? AgentBubble(
                                          first:
                                              at == 0 ||
                                              !inAgentTurn(
                                                rows[at - 1].items.last,
                                              ),
                                          last:
                                              at == rows.length - 1 ||
                                              !inAgentTurn(
                                                rows[at + 1].items.first,
                                              ),
                                          child: inner,
                                        )
                                      : inner,
                                ),
                              );
                            },
                            findChildIndexCallback: (key) {
                              final k = (key as ValueKey<String>).value;
                              final at = rows.lastIndexWhere((r) => r.key == k);
                              return at < 0
                                  ? null
                                  : rows.length - 1 - at + pending.length;
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
                          ?widget.overlay,
                        ],
                      ),
                    ),
                    ?widget.bottom,
                  ],
                ),
                if (widget.showHeader)
                  Positioned(
                    top: 0,
                    left: 0,
                    right: 0,
                    child: SafeArea(
                      bottom: false,
                      child: ChatHeader(
                        tab: widget.tab,
                        onTapTitle: widget.onTapTitle,
                        onTapRing: widget.onTapRing,
                        actions: widget.actions,
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
}

/// A commentable item with its pending comments painted: each passage highlighted with the comment's number in the
/// strip, a whole-message comment as a badge at the top right. It listens to the comments itself and rebuilds only
/// when the marks of this item change.
class _Marked extends StatefulWidget {
  const _Marked({required this.tab, required this.item});
  final WindowTab tab;
  final FeedItem item;

  @override
  State<_Marked> createState() => _MarkedState();
}

class _MarkedState extends State<_Marked> {
  List<Mark> _marks = const [];
  List<({String id, int n})> _whole = const [];

  @override
  void initState() {
    super.initState();
    widget.tab.comments.addListener(_changed);
    _compute();
  }

  @override
  void didUpdateWidget(_Marked old) {
    super.didUpdateWidget(old);
    if (old.tab != widget.tab) {
      old.tab.comments.removeListener(_changed);
      widget.tab.comments.addListener(_changed);
    }
    _compute();
  }

  @override
  void dispose() {
    widget.tab.comments.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    final before = (_marks, _whole);
    _compute();
    if (!listEquals(before.$1, _marks) || !listEquals(before.$2, _whole)) {
      setState(() {});
    }
  }

  String? get _id => switch (chatSource(widget.item)) {
    AnchorSourceMessage(:final id) => id,
    _ => null,
  };

  void _compute() {
    final strip = widget.tab.comments.sendable;
    final mine = [
      for (final (i, c) in strip.indexed)
        if (c.anchor case TextAnchor(
          source: AnchorSourceMessage(:final id, agent: null),
        ) when id == _id)
          (c: c, a: c.anchor as TextAnchor, n: i + 1),
    ];
    if (mine.isEmpty) {
      _marks = const [];
      _whole = const [];
      return;
    }
    final text = chatText(widget.item).text;
    final marks = <Mark>[], whole = <({String id, int n})>[];
    for (final m in mine) {
      final at = resolveAnchor(m.a, text);
      if (at == null) continue;
      if (at.start == 0 && at.end == text.length) {
        whole.add((id: m.c.id, n: m.n));
      } else {
        marks.add((
          start: at.start,
          end: at.end,
          id: m.c.id,
          sent: false,
          n: m.n,
        ));
      }
    }
    _marks = marks;
    _whole = whole;
  }

  void _open(String id) {
    final x = widget.tab.comments.all.where((c) => c.id == id).firstOrNull;
    if (x != null) editComment(context, widget.tab, x);
  }

  @override
  Widget build(BuildContext context) {
    final view = FeedItemView(widget.item, marks: _marks, onMark: _open);
    if (_whole.isEmpty) return view;
    return Stack(
      clipBehavior: Clip.none,
      children: [
        view,
        Positioned(
          top: 0,
          right: 0,
          child: Row(
            children: [
              for (final w in _whole)
                MarkBadge(id: w.id, n: w.n, onTap: () => _open(w.id)),
            ],
          ),
        ),
      ],
    );
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
          final box = context.findRenderObject() as RenderBox;
          // kept in the item's own coordinates: the item may move before "Select text" is chosen
          final at = box.globalToLocal(d.globalPosition);
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
  const FeedItemView(
    this.item, {
    super.key,
    this.listenerAt,
    this.marks = const [],
    this.onMark = _noMark,
  });
  final FeedItem item;

  /// Commented passages to paint (and number) in the text; a tap on one calls [onMark] with the comment's id.
  final List<Mark> marks;
  final void Function(String id) onMark;
  static void _noMark(String id) {}

  /// In selection mode: the Markdown is drawn block by block, each block's selection reported to its notifier.
  final SelectionListenerNotifier Function(int block)? listenerAt;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    Widget line(String text, {Color? color}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: TextStyle(color: color ?? c.mutedFg, fontSize: 13),
      ),
    );
    Widget userText(String text) => listenerAt == null && marks.isEmpty
        ? NbMarkdown(
            userMarkdownSource(text),
            blockSyntaxes: userBlockSyntaxes,
            inlineSyntaxes: userInlineSyntaxes,
            softLineBreak: true,
          )
        : FileMarkdown(
            text: text,
            listenerAt: listenerAt,
            marks: marks,
            onMark: onMark,
            parse: parseUserMessage,
            softLineBreak: true,
          );
    return switch (item) {
      UserItem(
        shownText: final text,
        id: final userId,
        text: final typed,
        :final idle,
        :final images,
        :final voice,
        :final voiceError,
        :final transcribing,
      ) =>
        idle
            ? line(t.idleCompact)
            : UserBubble(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (images.isNotEmpty && FileOpener.of(context) != null)
                      UserImages(tab: FileOpener.of(context)!, images: images),
                    if (voice != null)
                      VoiceBlock(
                        id: voice.id,
                        ms: voice.ms.toInt(),
                        wave: voice.wave,
                        load: voiceLoader(FileOpener.of(context), voice.id),
                        stage: voiceError != null
                            ? VoiceStage.error
                            : (transcribing
                                  ? VoiceStage.transcribing
                                  : VoiceStage.transcribed),
                        error: voiceError,
                        onRetry:
                            FileOpener.of(context)?.isRetrying(voice.id) ??
                                false
                            ? null
                            : () => retryVoice(context, voice),
                        transcript: () => userText(text),
                      )
                    else if (text.isNotEmpty || images.isEmpty)
                      userText(text),
                    if (FileOpener.of(context) case final tab?)
                      SentComments(tab: tab, id: userId, text: typed),
                  ],
                ),
              ),
      AssistantItem(:final text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: listenerAt == null && marks.isEmpty
            ? NbMarkdown(text)
            : FileMarkdown(
                text: text,
                listenerAt: listenerAt,
                marks: marks,
                onMark: onMark,
              ),
      ),
      ToolItem() => ToolLine(item as ToolItem),
      // a turn that ended well leaves no line: the header says when it was done
      DoneItem(:final secs, :final status, :final error) =>
        status == StopReason.interrupted || status == StopReason.failed
            ? line(
                status == StopReason.interrupted
                    ? t.turnInterrupted(duration(t, secs))
                    : t.turnFailed(duration(t, secs), error ?? ''),
              )
            : const SizedBox.shrink(),
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

/// Whether [it] is a piece of the agent's turn: its texts, tool lines, plans and shell blocks. A user message and the
/// lines (done, markers, notices) are not; they end the turn.
bool inAgentTurn(FeedItem it) => switch (it) {
  AssistantItem(:final text) => text.isNotEmpty,
  ToolItem() || PermissionItem() || ShellItem() => true,
  _ => false,
};

/// One piece of the agent's turn in its bubble: 8 px from the left edge and 28 from the right, in the agent's colour.
/// The pieces of a turn sit one under the other without a gap, so [first] rounds the top and [last] the bottom (its
/// left corner stays square, the tail).
class AgentBubble extends StatelessWidget {
  const AgentBubble({
    super.key,
    required this.first,
    required this.last,
    required this.child,
  });
  final bool first, last;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Padding(
      padding: EdgeInsets.fromLTRB(8, first ? 6 : 0, 28, last ? 6 : 0),
      child: Container(
        key: const ValueKey('agent-bubble'),
        padding: EdgeInsets.fromLTRB(12, first ? 6 : 0, 12, last ? 6 : 0),
        decoration: BoxDecoration(
          color: c.agentBubble,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(first ? 14 : 0),
            topRight: Radius.circular(first ? 14 : 0),
            bottomLeft: Radius.circular(last ? 4 : 0),
            bottomRight: Radius.circular(last ? 14 : 0),
          ),
        ),
        child: child,
      ),
    );
  }
}

/// The user's bubble: right-aligned, tinted with the primary colour, its lower right corner square. It shrinks to its
/// content and takes at most the screen's width less 28 px at the left and 8 at the right.
class UserBubble extends StatelessWidget {
  const UserBubble({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 6, 8, 6),
      child: Align(
        alignment: Alignment.centerRight,
        child: Container(
          key: const ValueKey('bubble'),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: c.userBubble,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(14),
              topRight: Radius.circular(14),
              bottomLeft: Radius.circular(14),
              bottomRight: Radius.circular(4),
            ),
            border: Border.all(color: c.primary.withValues(alpha: .45)),
          ),
          // as the desktop shows it, and as chatText reads it: Markdown with breaks, HTML as text
          child: child,
        ),
      ),
    );
  }
}

/// A voice message the phone has recorded and the window has not shown yet: Sending…, or failed with Retry.
class PendingVoiceBubble extends StatelessWidget {
  const PendingVoiceBubble(this.entry, this.outbox, {super.key});
  final PendingVoice entry;
  final VoiceOutbox outbox;

  @override
  Widget build(BuildContext context) => UserBubble(
    child: VoiceBlock(
      id: entry.key,
      ms: entry.ms,
      wave: entry.wave,
      load: () => outbox.bytes(entry),
      stage: entry.stage == OutStage.failed
          ? VoiceStage.sendFailed
          : VoiceStage.sending,
      onRetry: () => outbox.retry(entry),
      onDelete: () => outbox.remove(entry),
    ),
  );
}

String duration(AppLocalizations t, num secs) => secs < 60
    ? t.durationSecs(secs.round())
    : t.durationMins(secs ~/ 60, (secs % 60).round());

/// A tool call as one line (name and its main argument); its result opens on tap.
class ToolLine extends StatefulWidget {
  const ToolLine(
    this.item, {
    super.key,
    this.inGroup = false,
    this.media = true,
  });
  final ToolItem item;

  /// false when a group's head shows the pictures of its actions
  final bool media;

  /// Inside an open group a failed line shows its output unasked.
  final bool inGroup;

  @override
  State<ToolLine> createState() => _ToolLineState();
}

class _ToolLineState extends State<ToolLine> {
  // without a tab (no FileOpener) the state is the line's own
  bool? _local;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final it = widget.item;
    final running = it.result == null;
    final ui = FileOpener.of(context)?.feedUi;
    final open =
        (ui == null ? _local : ui.toolOpen(it.id)) ??
        (widget.inGroup && it.isError);
    // a file of the project the phone opens (Markdown, an image, a video) opens over the chat
    final tab = FileOpener.of(context);
    final path = toolPath(it);
    final file = tab == null || path == null
        ? null
        : projectPath(tab.root, path);
    return Padding(
      padding: EdgeInsets.only(left: it.sub ? 16 : 0, top: 2, bottom: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: running
                ? null
                : () => setState(() {
                    ui == null ? _local = !open : ui.setTool(it.id, !open);
                  }),
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
                if (!open && tab != null)
                  ListenableBuilder(
                    listenable: tab.comments,
                    builder: (context, _) {
                      final n = toolComments(tab.comments, it.id);
                      return n == 0
                          ? const SizedBox.shrink()
                          : Text(
                              ' · ${AppLocalizations.of(context).toolComments(n)}',
                              style: TextStyle(color: c.accent, fontSize: 13),
                            );
                    },
                  ),
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
          if (tab != null && widget.media)
            for (final m in mediaOf(tab, it)) MediaCard(tab: tab, spec: m),
          if (open && it.result != null)
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
