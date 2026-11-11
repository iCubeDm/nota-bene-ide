// Comment by paragraph: a tap on a paragraph of a final reply makes the whole paragraph the target (an accent bar and
// a tint, no scrim). In a list the target is the list item under the finger, not the list: a nested item is a target
// of its own, and a parent item covers its own text and its nested items. Above it floats one bubble of the quick
// labels (the first five and a chevron that grows the same bubble into all of them, named); below it a bar with Comment,
// Pin and Copy. A label makes a pending comment on the paragraph (the comment model of a selection, so the Comments pane
// and sending are unchanged), with no snackbar: the label shows on the paragraph. The same label again on the same
// paragraph takes it back, as a reaction in a messenger does; a screen reader hears a short announcement of either.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/anchor.dart';
import '../comments/chat_anchor.dart';
import '../comments/comment_sheet.dart';
import '../comments/strings.g.dart';
import '../l10n/app_localizations.dart';
import '../store/sizes.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'feed.dart';
import 'message_menu.dart' show barLabels, cutQuote;
import 'window_tab.dart';

const _bar = 48.0;
const _chip = 44.0;
const _gap = 6.0;
const _edge = 8.0;

/// The top-level blocks that are paragraphs of a reply. Code, diagrams, math blocks and rules keep their own taps.
const _targetTags = {
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'table', //
};

/// Whether top-level node [n] of a reply can be the target of a comment.
bool isParagraphNode(md.Node n) =>
    n is md.Element && _targetTags.contains(n.tag);

/// The paragraph of a reply as a target: [block] is its top-level node, and [li] the list item in it (-1: the node).
class _Para {
  _Para(
    this.ctx,
    this.item,
    this.block,
    this.li,
    this.text,
    this.start,
    this.end,
  );
  final BuildContext ctx;
  final AssistantItem item;
  final int block, li;
  final String text; // the reply's rendered text
  final int start, end; // the paragraph in it, trimmed
  String get quote => text.substring(start, end);
}

/// Which paragraph is the target, and what its bubble and bar do. One per chat.
class ParagraphTargets extends ChangeNotifier {
  ParagraphTargets(this.tab);
  final WindowTab tab;

  /// Below the floating header: the popup keeps clear of it.
  double topInset = 0;

  /// Above the floating message field with its strip and the nav bar (not the blur's fade): the popup and the snackbar
  /// keep clear of it.
  double bottomInset = 0;

  _Para? _sel;
  OverlayEntry? _entry;
  late final _Back _back = _Back(clear);
  ModalRoute<Object?>? _route;

  bool isTarget(String id, int block, [int li = -1]) =>
      _sel != null &&
      _sel!.item.id == id &&
      _sel!.block == block &&
      _sel!.li == li;

  /// The keys list items' blocks are found by: a tap on a bullet, outside its block, goes through them. Per chat, so
  /// that two chats showing the same reply never share a key.
  final _itemKeys = <String, GlobalKey>{};

  GlobalKey itemKey(String id, int block, int li) =>
      _itemKeys.putIfAbsent('$id:$block:$li', GlobalKey.new);

  /// A tap on the bullet of item [li]: the item as a target, as a tap on its text makes it.
  void tapBullet(AssistantItem item, int block, int li) {
    final ctx = itemKey(item.id, block, li).currentContext;
    if (ctx != null) toggle(ctx, item, block, li);
  }

  /// The paragraph [block] of [item] (its list item [li], when it is one) as a target, or none when it was one already.
  void toggle(BuildContext ctx, AssistantItem item, int block, [int li = -1]) {
    if (isTarget(item.id, block, li)) return clear();
    final p = _para(ctx, item, block, li);
    if (p == null) return;
    _drop();
    _sel = p;
    // Android's Back clears the target before it leaves the chat, as it closes the message menu
    _route = ModalRoute.of(ctx)?..registerPopEntry(_back);
    final overlay = Overlay.maybeOf(ctx);
    if (overlay != null) {
      _entry = OverlayEntry(builder: (_) => _Popup(targets: this));
      overlay.insert(_entry!);
    }
    notifyListeners();
  }

  _Para? _para(BuildContext ctx, AssistantItem item, int block, int li) {
    if (!item.final_) return null;
    final r = chatText(item);
    if (block >= r.blocks.length) return null;
    final part = li < 0 ? r.block(block) : r.item(block, li);
    if (part == null) return null;
    var (:start, :end) = part;
    while (start < end && r.text[start] == ' ') {
      start++;
    }
    while (end > start && r.text[end - 1] == ' ') {
      end--;
    }
    return start < end ? _Para(ctx, item, block, li, r.text, start, end) : null;
  }

  void _drop() {
    _route?.unregisterPopEntry(_back);
    _route = null;
    _entry?.remove();
    _entry?.dispose();
    _entry = null;
  }

  void clear() {
    if (_sel == null) return;
    _sel = null;
    _drop();
    notifyListeners();
  }

  @override
  void dispose() {
    _drop();
    _itemKeys.clear();
    super.dispose();
  }

  Comment _add(
    _Para p,
    QuickLabelId? label,
    String text, {
    List<VoiceClip>? voice,
    List<String>? images,
  }) => tab.comments.add(
    makeAnchor(AnchorSourceMessage(id: p.item.id), p.text, p.start, p.end),
    text,
    label,
    voice: voice,
    images: images,
  );

  /// The target as the reply is now, not as it was when tapped (null: the reply is gone from the feed).
  _Para? _fresh(_Para p) {
    for (final it in tab.feed.items) {
      if (it is AssistantItem && it.id == p.item.id) {
        return p.ctx.mounted ? _para(p.ctx, it, p.block, p.li) : null;
      }
    }
    return null;
  }

  /// A snackbar that goes after [seconds] and floats above the message field, not over it.
  void _snack(BuildContext ctx, Widget content, {SnackBarAction? action}) {
    final messenger = ScaffoldMessenger.maybeOf(ctx);
    if (messenger == null) return;
    var bottom = 8.0;
    final scaffold = Scaffold.maybeOf(ctx)?.context.findRenderObject();
    final view = Scrollable.maybeOf(ctx)?.context.findRenderObject();
    if (scaffold is RenderBox && view is RenderBox && view.hasSize) {
      final top = uiOffset(ctx, scaffold.localToGlobal(Offset.zero)).dy;
      final end = top + scaffold.size.height;
      final viewTop = uiOffset(ctx, view.localToGlobal(Offset.zero)).dy;
      bottom = math.max(
        8,
        end - (viewTop + view.size.height) + bottomInset + 8,
      );
    }
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(
        content: content,
        action: action,
        persist: false,
        duration: const Duration(seconds: 4),
        behavior: SnackBarBehavior.floating,
        margin: EdgeInsets.fromLTRB(8, 0, 8, bottom),
      ),
    );
  }

  void _label(QuickLabel l) {
    final sel = _sel;
    final p = sel == null ? null : _fresh(sel);
    if (sel == null || p == null) return clear();
    final t = AppLocalizations.of(p.ctx);
    final lang = Localizations.localeOf(p.ctx).languageCode;
    final name = '${l.emoji} ${l.textIn(lang)}';
    // the same label again on the same paragraph takes it back, as a reaction in a messenger does
    final again = tab.comments.pending
        .where(
          (c) =>
              c.label == l.id &&
              c.text.isEmpty &&
              (c.voice ?? const []).isEmpty &&
              switch (c.anchor) {
                TextAnchor(
                  source: AnchorSourceMessage(:final id, agent: null),
                  :final start,
                  :final end,
                ) =>
                  id == p.item.id && start == p.start && end == p.end,
                _ => false,
              },
        )
        .firstOrNull;
    final said = again == null
        ? t.paragraphLabelAdded(name)
        : t.paragraphLabelRemoved(name);
    if (again == null) {
      _add(p, l.id, '');
    } else {
      tab.comments.remove(again.id);
    }
    clear();
    // the label shows on the paragraph as a comment: no snackbar, only a word for a screen reader
    SemanticsService.sendAnnouncement(
      View.of(p.ctx),
      said,
      Directionality.of(p.ctx),
    );
  }

  /// Comment opens the sheet with the paragraph as its quote. Also TalkBack's custom action.
  Future<void> comment(
    BuildContext ctx,
    AssistantItem item,
    int block, [
    int li = -1,
  ]) async {
    clear();
    if (!ctx.mounted) return;
    final p = _fresh(_Para(ctx, item, block, li, '', 0, 0));
    if (p == null) return;
    final res = await showCommentSheet(ctx, quote: cutQuote(p.quote), tab: tab);
    if (res is SheetSave) {
      _add(p, res.label, res.text, voice: res.voice, images: res.imageIds);
    }
  }

  void _copy() {
    final sel = _sel;
    final p = sel == null ? null : _fresh(sel);
    clear();
    if (p == null) return;
    Clipboard.setData(ClipboardData(text: p.quote));
    _snack(p.ctx, Text(AppLocalizations.of(p.ctx).paragraphCopied));
  }
}

/// Hands a chat's [ParagraphTargets] to the replies in it. Null above it: nothing is a target.
class ParagraphHost extends InheritedWidget {
  const ParagraphHost({super.key, required this.targets, required super.child});
  final ParagraphTargets targets;

  static ParagraphTargets? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ParagraphHost>()?.targets;

  @override
  bool updateShouldNotify(ParagraphHost old) => targets != old.targets;
}

/// A paragraph of a reply (or one item [li] of its list): a button for a tap and for TalkBack (Comment), painted as
/// the target while it is one. An item's tint reaches left by [bleed] to hold its bullet.
class ParagraphBlock extends StatelessWidget {
  const ParagraphBlock({
    super.key,
    required this.targets,
    required this.item,
    required this.block,
    required this.child,
    this.li = -1,
    this.bleed = 9,
  });
  final ParagraphTargets targets;
  final AssistantItem item;
  final int block, li;
  final double bleed;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    return ListenableBuilder(
      listenable: targets,
      child: child,
      builder: (context, child) {
        final on = targets.isTarget(item.id, block, li);
        // a button holding the paragraph's own nodes: links and comment badges stay reachable inside it. Pin joins
        // the custom actions with pins (#181).
        return Semantics(
          container: true,
          button: true,
          selected: on,
          customSemanticsActions: {
            CustomSemanticsAction(label: t.comment): () =>
                targets.comment(context, item, block, li),
          },
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => targets.toggle(context, item, block, li),
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                if (on) ...[
                  // the bubble pads 12 each side: the tint reaches into it, the bar sits at its edge
                  Positioned(
                    key: ValueKey(
                      li < 0
                          ? 'para-target:${item.id}:$block'
                          : 'para-target:${item.id}:$block.$li',
                    ),
                    left: -bleed,
                    right: -9,
                    top: -2,
                    bottom: -2,
                    child: ColoredBox(color: c.accent.withValues(alpha: 0.14)),
                  ),
                  Positioned(
                    left: -bleed,
                    top: -2,
                    bottom: -2,
                    width: 3,
                    child: ColoredBox(color: c.accent),
                  ),
                ],
                child!,
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Popup extends StatefulWidget {
  const _Popup({required this.targets});
  final ParagraphTargets targets;

  @override
  State<_Popup> createState() => _PopupState();
}

class _PopupState extends State<_Popup> {
  bool _all = false;
  Rect? _para;
  Rect? _bounds;
  double? _viewLeft;

  static bool _finite(Rect r) =>
      r.left.isFinite &&
      r.top.isFinite &&
      r.right.isFinite &&
      r.bottom.isFinite;

  _Para get _p => widget.targets._sel!;

  @override
  void initState() {
    super.initState();
    _watch();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _measure();
  }

  /// The paragraph and the feed it scrolls in, in screen coordinates; false once it is gone or scrolled out.
  bool _measure() {
    final ctx = _p.ctx;
    final box = ctx.mounted ? ctx.findRenderObject() : null;
    if (box is! RenderBox || !box.attached || !box.hasSize) return false;
    final para = uiOffset(ctx, box.localToGlobal(Offset.zero)) & box.size;
    final screen = Offset.zero & MediaQuery.sizeOf(context);
    final view = Scrollable.maybeOf(ctx)?.context.findRenderObject();
    var bounds = screen;
    if (view is RenderBox && view.hasSize) {
      bounds = uiOffset(context, view.localToGlobal(Offset.zero)) & view.size;
      // the pane moves sideways under a swipe, and away when the page changes: the target does not go with it
      final left = _viewLeft ??= bounds.left;
      if ((bounds.left - left).abs() > 1) return false;
    }
    bounds = Rect.fromLTRB(
      bounds.left,
      bounds.top + widget.targets.topInset,
      bounds.right,
      bounds.bottom - widget.targets.bottomInset,
    );
    if (!_finite(para) || !_finite(bounds) || !bounds.overlaps(screen)) {
      return false;
    }
    if (para.bottom <= bounds.top || para.top >= bounds.bottom) return false;
    if (para.right <= bounds.left || para.left >= bounds.right) return false;
    _para = para;
    _bounds = bounds;
    return true;
  }

  /// Follows the paragraph as the feed scrolls: a frame after each one that moved it.
  void _watch() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || widget.targets._sel == null) return;
      final route = ModalRoute.of(_p.ctx);
      final before = (_para, _bounds);
      if (!_measure() || (route != null && !route.isCurrent)) {
        widget.targets.clear();
        return;
      }
      if (before != (_para, _bounds)) setState(() {});
      _watch();
    });
  }

  @override
  Widget build(BuildContext context) {
    final targets = widget.targets;
    final para = _para, bounds = _bounds;
    if (targets._sel == null || para == null || bounds == null) {
      return const SizedBox.shrink();
    }
    final c = Theme.of(context).extension<NbColors>()!;
    final width = MediaQuery.sizeOf(context).width;
    return Material(
      type: MaterialType.transparency,
      child: Stack(
        children: [
          // a press outside the popup and the paragraph clears the target; the press goes on to what is under it
          Positioned.fill(
            child: Listener(
              behavior: HitTestBehavior.translucent,
              onPointerDown: (e) {
                if (!(_para?.contains(e.localPosition) ?? false)) {
                  targets.clear();
                }
              },
            ),
          ),
          Positioned.fill(
            child: CustomMultiChildLayout(
              delegate: _Place(para, bounds),
              children: [
                LayoutId(
                  id: #bubble,
                  child: _Panel(
                    c: c,
                    pad: 4,
                    child: _labels(context, math.min(width - 2 * _edge, 336)),
                  ),
                ),
                LayoutId(
                  id: #bar,
                  child: _Panel(c: c, pad: 0, child: _actions(context)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _labels(BuildContext context, double gridWidth) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final targets = widget.targets;
    final fold = IconButton(
      key: const ValueKey('para-more'),
      tooltip: t.labelsAll,
      visualDensity: VisualDensity.compact,
      constraints: const BoxConstraints.tightFor(width: _chip, height: _chip),
      padding: EdgeInsets.zero,
      color: c.mutedFg,
      icon: Icon(_all ? Icons.expand_less : Icons.expand_more),
      onPressed: () => setState(() => _all = !_all),
    );
    Widget content;
    if (!_all) {
      // wraps when the screen is narrower than the six, as at a large interface size
      content = Wrap(
        key: const ValueKey('para-labels'),
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (final l in barLabels)
            Tooltip(
              message: l.textIn(lang),
              child: InkResponse(
                onTap: () => targets._label(l),
                radius: _chip / 2,
                child: SizedBox.square(
                  dimension: _chip,
                  child: Center(
                    child: Text(l.emoji, style: const TextStyle(fontSize: 24)),
                  ),
                ),
              ),
            ),
          fold,
        ],
      );
    } else {
      final cell = (gridWidth - 16) / 4;
      // the cell grows with the text scale: the emoji and two lines of the name
      final sc = MediaQuery.textScalerOf(context);
      final iconH = math.max(30.0, sc.scale(24) * 1.25);
      final cellH = math.max(66.0, 7 + iconH + 2 * sc.scale(11) * 1.15);
      Widget one(Widget top, String name, VoidCallback onTap, {Color? color}) =>
          InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(8),
            child: SizedBox(
              width: cell,
              height: cellH,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(2, 4, 2, 2),
                child: Column(
                  children: [
                    SizedBox(
                      height: iconH,
                      child: Center(child: top),
                    ),
                    Text(
                      name,
                      textAlign: TextAlign.center,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11,
                        height: 1.15,
                        color: color ?? c.foreground,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
      content = SizedBox(
        key: const ValueKey('para-labels'),
        width: gridWidth - 16,
        child: Wrap(
          children: [
            for (final l in quickLabels)
              one(
                Text(l.emoji, style: const TextStyle(fontSize: 24)),
                l.textIn(lang),
                () => targets._label(l),
              ),
            KeyedSubtree(
              key: const ValueKey('para-more'),
              child: one(
                Icon(Icons.expand_less, color: c.mutedFg),
                t.paragraphLess,
                () => setState(() => _all = false),
                color: c.mutedFg,
              ),
            ),
          ],
        ),
      );
    }
    return AnimatedSize(
      duration: const Duration(milliseconds: 150),
      alignment: Alignment.bottomLeft,
      child: content,
    );
  }

  Widget _actions(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final targets = widget.targets;
    Widget button(Widget icon, String label, VoidCallback? onTap) {
      final color = onTap == null
          ? c.mutedFg.withValues(alpha: 0.5)
          : c.foreground;
      return InkWell(
        onTap: onTap,
        child: SizedBox(
          height: _bar,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconTheme.merge(
                  data: IconThemeData(color: color, size: 18),
                  child: icon,
                ),
                const SizedBox(width: 8),
                Text(label, style: TextStyle(color: color, fontSize: 14)),
              ],
            ),
          ),
        ),
      );
    }

    final p = targets._sel!;
    return Wrap(
      key: const ValueKey('para-bar'),
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        button(
          const NbIcon(NbGlyph.comments),
          t.comment,
          () => targets.comment(p.ctx, p.item, p.block, p.li),
        ),
        // pins come with their own feature
        button(const Icon(Icons.push_pin_outlined), t.paragraphPin, null),
        button(const NbIcon(NbGlyph.copy), t.menuCopy, targets._copy),
      ],
    );
  }
}

/// The bubble above the paragraph and the bar below it, kept inside the feed: a bubble that does not fit above sits at
/// the top of the feed, a bar that does not fit below at its bottom (over the paragraph, when that is taller than the
/// feed). Both start at the paragraph's left edge unless the screen's edge is in the way.
class _Place extends MultiChildLayoutDelegate {
  _Place(this.para, this.bounds);
  final Rect para, bounds;

  @override
  void performLayout(Size size) {
    final room = BoxConstraints.loose(
      Size(size.width - 2 * _edge, size.height),
    );
    final b = layoutChild(#bubble, room), a = layoutChild(#bar, room);
    double x(Size s) => math
        .min(para.left, size.width - _edge - s.width)
        .clamp(_edge, double.infinity);
    final bt = math
        .max(bounds.top + _gap, para.top - _gap - b.height)
        .clamp(bounds.top, math.max(bounds.top, bounds.bottom - b.height))
        .toDouble();
    final at = math
        .min(bounds.bottom - a.height, para.bottom + _gap)
        .clamp(bounds.top, math.max(bounds.top, bounds.bottom - a.height))
        .toDouble();
    positionChild(#bubble, Offset(x(b), bt));
    positionChild(#bar, Offset(x(a), at));
  }

  @override
  bool shouldRelayout(_Place old) => old.para != para || old.bounds != bounds;
}

class _Panel extends StatelessWidget {
  const _Panel({required this.c, required this.pad, required this.child});
  final NbColors c;
  final double pad;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    padding: EdgeInsets.all(pad),
    decoration: BoxDecoration(
      color: c.popover,
      borderRadius: BorderRadius.circular(24),
      border: Border.all(color: c.border),
      boxShadow: const [BoxShadow(color: Color(0x44000000), blurRadius: 12)],
    ),
    child: ClipRRect(borderRadius: BorderRadius.circular(24), child: child),
  );
}

class _Back extends PopEntry<Object?> {
  _Back(this.clear);
  final VoidCallback clear;
  @override
  final ValueNotifier<bool> canPopNotifier = ValueNotifier(false);
  @override
  void onPopInvokedWithResult(bool didPop, Object? result) {
    // clearing unregisters this entry, which the route is iterating over
    if (!didPop) scheduleMicrotask(clear);
  }
}
