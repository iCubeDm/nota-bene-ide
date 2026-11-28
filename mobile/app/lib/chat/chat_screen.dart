// One window's chat: the floating header pill (session, model, limits), a state line, the feed (newest at the bottom), and below it
// whatever the caller puts there (the composer).
import 'package:flutter/foundation.dart' show listEquals, setEquals;
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart'
    show AnchorSourceMessage, TextAnchor;

import '../l10n/app_localizations.dart';
import '../comments/anchor.dart';
import '../comments/chat_anchor.dart';
import '../comments/comment_strip.dart' show editComment;
import '../files/file_markdown.dart';
import '../store/sizes.dart';
import '../theme.dart';
import 'bubbles.dart';
import 'chat_header.dart';
import 'comment_target.dart';
import 'feed.dart';
import 'files.dart';
import 'held.dart';
import '../ui/blur_band.dart';
import 'message_menu.dart';
import 'message_selection.dart';
import 'paragraph.dart';
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

  /// The height of the floating bottom band (the field with its strip and the nav bar), which the feed keeps clear.
  /// Only the feed's padding and the popups listen to it.
  final _band = ValueNotifier<double>(0);

  /// The composer's floating paperclip, or ⇤ and ⇥, are up (they ask for the room Stop takes).
  final _clip = ValueNotifier<bool>(false);

  /// The top of the bottom band, which ⇤ and ⇥ float above.
  final _bandTop = LayerLink();
  bool _seeded = false;

  /// The top band's height as the last build knew it (the feed keeps this much clear).
  double _topClear = 0;
  final _targets = <String, GlobalKey>{};
  late ParagraphTargets _paragraphs = ParagraphTargets(
    widget.tab,
    bottom: _band,
  );

  @override
  void initState() {
    super.initState();
    widget.focus?._go = _scrollTo;
  }

  @override
  void didUpdateWidget(ChatScreen old) {
    super.didUpdateWidget(old);
    if (old.tab != widget.tab) {
      _paragraphs.dispose();
      _paragraphs = ParagraphTargets(widget.tab, bottom: _band);
    }
    if (old.focus != widget.focus) {
      old.focus?._go = null;
      widget.focus?._go = _scrollTo;
    }
  }

  @override
  void dispose() {
    if (widget.focus?._go == _scrollTo) widget.focus?._go = null;
    _scroll.dispose();
    _band.dispose();
    _clip.dispose();
    _paragraphs.dispose();
    super.dispose();
  }

  /// The feed key of the item message [id] names, or null.
  String? _keyOf(String id) {
    for (final it in widget.tab.windowState.feed.items) {
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
    final rows = feedRows(widget.tab.windowState.feed.items);
    final at = rows.indexWhere((r) => r.items.any((it) => feedKey(it) == key));
    if (at < 0) return false;
    final row = rows[at];
    final fromEnd = rows.length - 1 - at;
    // the action's output opens with it, and its group when it has one
    final isTool = key.startsWith('tool:');
    final inner = isTool && row.isGroup ? key : null;
    if (isTool) {
      widget.tab.windowState.feedUi.reveal(
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
        // a third of the way down the part of the feed the bands leave free
        final view = _scroll.position.viewportDimension;
        final free = view - _topClear - _band.value - blurFade;
        await Scrollable.ensureVisible(
          innerTarget?.currentContext ?? target.currentContext!,
          alignment: view <= 0
              ? .3
              : ((_topClear + .3 * free) / view).clamp(0.0, 1.0),
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

  /// The feed, newest at the bottom: the only part of the chat that listens to the window as it streams (issue 565).
  Widget _feed(EdgeInsets inset, double top) => ListenableBuilder(
    listenable: Listenable.merge([widget.tab, widget.tab.voiceOutbox]),
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final f = widget.tab.windowState.feed;
      final pending = widget.tab.voiceOutbox.entries;
      // issue 499: the messages the window holds behind a pending restart or compaction, and the pending compaction's chip
      final held = widget.tab.windowState.held;
      final chip = widget.tab.windowState.compactPending ? 1 : 0;
      final below = chip + pending.length + held.length;
      final items = f.items;
      final rows = feedRows(items);
      // reversed: the newest item sits at the widget.bottom and stays in view while the user is there
      return ValueListenableBuilder<double>(
        valueListenable: _band,
        builder: (context, band, _) => ValueListenableBuilder<bool>(
          valueListenable: _clip,
          builder: (context, clip, _) => ListView.builder(
            key: const ValueKey('feed'),
            controller: _scroll,
            reverse: true,
            // full width: the bubbles keep their own margins
            padding: EdgeInsets.fromLTRB(
              inset.left,
              top,
              inset.right,
              band +
                  // the blur's fade above the field
                  (widget.bottom == null ? 0 : blurFade) +
                  // the floating Stop and paperclip must not cover the end of the last bubble
                  (clip ||
                          (widget.tab.connection.state == TabState.open &&
                              widget.tab.windowState.busy)
                      ? 8 + 56
                      : 8),
            ),
            itemCount: rows.length + below + (f.earlier > 0 ? 1 : 0),
            itemBuilder: (context, i) {
              if (i < chip) {
                return CompactPendingChip(
                  widget.tab,
                  key: const ValueKey('compact-pending'),
                );
              }
              i -= chip;
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
              // then the held messages: they go after the restart and the compaction
              if (i < held.length) {
                final h = held[held.length - 1 - i];
                return HeldBubble(
                  h,
                  restart: widget.tab.windowState.restartPending,
                  key: ValueKey('held:${h.id}'),
                );
              }
              i -= held.length;
              if (i == rows.length) {
                return Center(
                  child: TextButton(
                    onPressed: widget.tab.windowState.loadEarlier,
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
                          widget.itemBuilder?.call(context, it) ??
                          (chatSource(it) == null
                              ? FeedItemView(it)
                              : _Marked(tab: widget.tab, item: it)),
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
                              at == 0 || !inAgentTurn(rows[at - 1].items.last),
                          last:
                              at == rows.length - 1 ||
                              !inAgentTurn(rows[at + 1].items.first),
                          child: inner,
                        )
                      : inner,
                ),
              );
            },
            findChildIndexCallback: (key) {
              final k = (key as ValueKey<String>).value;
              final at = rows.lastIndexWhere((r) => r.key == k);
              return at < 0 ? null : rows.length - 1 - at + below;
            },
          ),
        ),
      );
    },
  );

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    // the feed keeps the floating header clear
    final top =
        MediaQuery.paddingOf(context).top +
        (widget.showHeader ? ChatHeader.extent : 0) +
        widget.extraTop;
    _topClear = top;
    // the feed runs to the screen's bottom: the nav bar's room is the band's, the feed keeps the band clear
    final inset = MediaQuery.paddingOf(context);
    final safe = inset.bottom;
    // before the first measure: a one-line field with its margins
    if (widget.bottom == null) {
      _band.value = safe;
    } else if (!_seeded) {
      _band.value = 64 + safe;
    }
    _seeded = true;
    return Scaffold(
      body: FileOpener(
        tab: widget.tab,
        child: ParagraphHost(
          targets: _paragraphs..topInset = top,
          child: FloatingRoom(
            clip: _clip,
            band: _bandTop,
            child: BandInset(
              inset: _band,
              child: BackdropGroup(
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: Stack(
                        children: [_feed(inset, top), ?widget.overlay],
                      ),
                    ),
                    if (widget.bottom case final bottom?)
                      // the field floats over the feed: the blur starts a little above it and runs to the nav bar; the field's
                      // margins and the nav bar take taps, the fade above passes them to the feed
                      Positioned(
                        left: 0,
                        right: 0,
                        bottom: 0,
                        child: Stack(
                          clipBehavior: Clip.none,
                          children: [
                            const Positioned(
                              key: ValueKey('blur-bottom'),
                              top: -blurFade,
                              left: 0,
                              right: 0,
                              bottom: 0,
                              child: BlurBand(top: false, fade: blurFade),
                            ),
                            SizeReporter(
                              onSize: (s) => _band.value = s.height,
                              child: Listener(
                                key: const ValueKey('band-solid-bottom'),
                                behavior: HitTestBehavior.opaque,
                                child: Padding(
                                  padding: EdgeInsets.fromLTRB(
                                    inset.left,
                                    0,
                                    inset.right,
                                    safe,
                                  ),
                                  child: CompositedTransformTarget(
                                    link: _bandTop,
                                    child: bottom,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ValueListenableBuilder<double>(
                      valueListenable: _band,
                      builder: (context, band, _) => Positioned(
                        left: 0,
                        right: 0,
                        bottom: band,
                        child: ListenableBuilder(
                          listenable: widget.tab.windowState,
                          builder: (context, _) =>
                              widget.tab.windowState.feed.compacting
                              ? IgnorePointer(
                                  child: LinearProgressIndicator(
                                    minHeight: 2,
                                    color: c.accent,
                                  ),
                                )
                              : const SizedBox.shrink(),
                        ),
                      ),
                    ),
                    if (widget.showHeader)
                      Positioned(
                        top: 0,
                        left: 0,
                        right: 0,
                        height: top,
                        child: const BlurBand(
                          key: ValueKey('blur-top'),
                          top: true,
                        ),
                      ),
                    if (widget.showHeader)
                      Positioned(
                        top: 0,
                        left: 0,
                        right: 0,
                        height: top - 4,
                        child: const Listener(
                          key: ValueKey('band-solid-top'),
                          behavior: HitTestBehavior.opaque,
                        ),
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
          ),
        ),
      ),
    );
  }
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
  Set<String> _inert = const {};

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
    final before = (_marks, _whole, _inert);
    _compute();
    if (!listEquals(before.$1, _marks) ||
        !listEquals(before.$2, _whole) ||
        !setEquals(before.$3, _inert)) {
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
      _inert = const {};
      return;
    }
    // a quick label alone: its text is a paragraph's, and a tap on it targets the paragraph (to take the label back)
    _inert = {
      for (final m in mine)
        if (m.c.label != null &&
            m.c.text.isEmpty &&
            (m.c.voice ?? const []).isEmpty)
          m.c.id,
    };
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
    final item = widget.item;
    final targets = ParagraphHost.maybeOf(context);
    final view = FeedItemView(
      item,
      marks: _marks,
      onMark: _open,
      inertMarks: _inert,
      wrapBlock: targets == null || item is! AssistantItem
          ? null
          : (i, n, child) => isParagraphNode(n) && !isListNode(n)
                ? ParagraphBlock(
                    targets: targets,
                    item: item,
                    block: i,
                    child: child,
                  )
                : child,
      // a list's items are the targets, not the list
      wrapItem: targets == null || item is! AssistantItem
          ? null
          : (i, li, child, bullet) => ParagraphBlock(
              key: targets.itemKey(item.id, i, li),
              targets: targets,
              item: item,
              block: i,
              li: li,
              bleed: bullet,
              child: child,
            ),
      tapItem: targets == null || item is! AssistantItem
          ? null
          : (i, li) => targets.tapBullet(item, i, li),
    );
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
          final rect =
              uiOffset(context, box.localToGlobal(Offset.zero)) & box.size;
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
