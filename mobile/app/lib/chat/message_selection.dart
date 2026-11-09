// One message in selection mode: its text in a SelectionArea (the word at the long-press selected, or all of it), a
// vertical toolbar (Comment, Copy, Select all) in place of Flutter's, and the selection turned into a text anchor
// the way the file screen does it (per-block selection listeners, then locateSelection on the rendered text).
import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';

import '../comments/anchor.dart';
import '../comments/chat_anchor.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'chat_screen.dart' show FeedItemView;
import 'feed.dart';
import 'window_tab.dart';

const _row = 44.0;

class SelectableMessage extends StatefulWidget {
  const SelectableMessage({
    super.key,
    required this.tab,
    required this.item,
    required this.onDone,
    this.from,
  });

  final WindowTab tab;
  final FeedItem item;

  /// Where the press was, in the message's own coordinates: the word there starts selected; null selects all.
  final Offset? from;

  /// Selection mode ends: a tap outside, or a comment made.
  final VoidCallback onDone;

  @override
  State<SelectableMessage> createState() => _SelectableMessageState();
}

class _SelectableMessageState extends State<SelectableMessage> {
  final _area = GlobalKey<SelectionAreaState>();
  final _listeners = <int, SelectionListenerNotifier>{};
  BuildContext? _inner;
  Timer? _press;
  Offset? _at;
  static const _pointer = 0x4e42;

  @override
  void initState() {
    super.initState();
    _after(1, _start);
  }

  /// [f] after [frames] more frames: the selectables register with the area as the first one lays them out.
  void _after(int frames, VoidCallback f) {
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => frames <= 1 ? f() : _after(frames - 1, f),
    );
    WidgetsBinding.instance.scheduleFrame();
  }

  @override
  void dispose() {
    if (_press?.isActive ?? false) {
      _press!.cancel();
      GestureBinding.instance.handlePointerEvent(
        PointerCancelEvent(pointer: _pointer, position: _at!),
      );
    }
    for (final l in _listeners.values) {
      l.dispose();
    }
    super.dispose();
  }

  /// All of the message selected once the area has taken its text (a few frames in; until then ask again), then the
  /// word under the press: the area's own long press is replayed at that point, so the word, the handles and the
  /// toolbar come as they do after a real one (a select-word event sent to the area's handler selects the word but
  /// brings neither: showing the toolbar is private to the region). Where no word is there, all stays selected.
  void _start([int tries = 0]) {
    final region = _area.currentState?.selectableRegion;
    if (!mounted || region == null) return;
    region.selectAll(SelectionChangedCause.toolbar);
    if (_selected.isEmpty) {
      if (tries < 30) _after(1, () => _start(tries + 1));
      return;
    }
    // the press as it was in the message, found again in the message's box as it is now: the message may have moved
    // since the menu opened. Outside the box, all stays selected.
    final rel = widget.from, box = context.findRenderObject();
    if (rel == null || box is! RenderBox || !box.hasSize) return;
    if (!(Offset.zero & box.size).contains(rel)) return;
    final at = box.localToGlobal(rel);
    region.clearSelection();
    final down = PointerDownEvent(pointer: _pointer, position: at);
    GestureBinding.instance.handlePointerEvent(down);
    _press = Timer(kLongPressTimeout + const Duration(milliseconds: 50), () {
      _press = null;
      GestureBinding.instance.handlePointerEvent(
        PointerUpEvent(pointer: _pointer, position: at),
      );
      _after(1, () {
        if (mounted && _selected.isEmpty) {
          region.selectAll(SelectionChangedCause.toolbar);
        }
      });
    });
    _at = at;
  }

  /// The area's own selection handler: it answers for the selection as it is now, which the area's change callback
  /// does not report after a selection made by code.
  SelectionHandler? get _selectable {
    final inner = _inner;
    final r = inner == null ? null : SelectionContainer.maybeOf(inner);
    return r is SelectionHandler ? r as SelectionHandler : null;
  }

  String get _selected => _selectable?.getSelectedContent()?.plainText ?? '';

  SelectionListenerNotifier _listenerAt(int i) =>
      _listeners.putIfAbsent(i, SelectionListenerNotifier.new);

  ({int start, int end})? _locate(RenderedText r) {
    for (final i in _listeners.keys.toList()..sort()) {
      final l = _listeners[i]!;
      if (!l.registered || i >= r.blocks.length) continue;
      final range = l.selection.range;
      if (range == null || l.selection.status == SelectionStatus.none) {
        continue;
      }
      final block = r.block(i);
      return locateSelection(
        r,
        _selected,
        block.start + range.startOffset,
        within: block,
      );
    }
    return null;
  }

  Future<void> _comment() async {
    final source = chatSource(widget.item);
    final r = chatText(widget.item);
    final at = _locate(r);
    if (source == null || at == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context).commentNotPlaced)),
      );
      return;
    }
    final res = await showCommentSheet(
      context,
      quote: r.text.substring(at.start, at.end),
    );
    if (res is! SheetSave) return;
    widget.tab.comments.add(
      makeAnchor(source, r.text, at.start, at.end),
      res.text,
      res.label,
    );
    widget.onDone();
  }

  Widget _toolbar(BuildContext context, SelectableRegionState state) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final anchors = state.contextMenuAnchors;
    final pad = MediaQuery.paddingOf(context).top + 8;
    Widget entry(String label, VoidCallback onTap) => InkWell(
      onTap: onTap,
      child: SizedBox(
        height: _row,
        child: Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(label, style: TextStyle(color: c.foreground)),
          ),
        ),
      ),
    );
    return Padding(
      padding: EdgeInsets.fromLTRB(8, pad, 8, 8),
      child: CustomSingleChildLayout(
        delegate: TextSelectionToolbarLayoutDelegate(
          anchorAbove: anchors.primaryAnchor - Offset(8, pad),
          anchorBelow:
              (anchors.secondaryAnchor ?? anchors.primaryAnchor) -
              Offset(8, pad),
        ),
        child: Material(
          color: c.popover,
          elevation: 6,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: BorderSide(color: c.border),
          ),
          clipBehavior: Clip.antiAlias,
          child: SizedBox(
            width: 168,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                entry(t.comment, () {
                  state.hideToolbar(false);
                  _comment();
                }),
                entry(t.menuCopy, () {
                  Clipboard.setData(ClipboardData(text: _selected));
                  state.hideToolbar();
                }),
                entry(
                  t.menuSelectAll,
                  () => state.selectAll(SelectionChangedCause.toolbar),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => TapRegion(
    // the handles and the toolbar belong to the region's own group
    groupId: SelectableRegion,
    onTapOutside: (_) => widget.onDone(),
    child: SelectionArea(
      key: _area,
      contextMenuBuilder: _toolbar,
      child: Builder(
        builder: (context) {
          _inner = context;
          return FeedItemView(widget.item, listenerAt: _listenerAt);
        },
      ),
    ),
  );
}
