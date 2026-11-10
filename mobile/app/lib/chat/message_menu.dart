// The menu of a long-pressed message, Telegram-like: over a scrim, the message lifted at its place, a row of the
// quick labels above it (the web's floating bar: the first five, the rest behind "⌄") and a vertical menu below it.
// An overlay, not a route; Android's back closes it first (the route under it is told not to pop meanwhile).
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/anchor.dart';
import '../comments/chat_anchor.dart';
import '../comments/comment_sheet.dart';
import '../comments/strings.g.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'chat_screen.dart' show FeedItemView;
import 'feed.dart';
import 'window_tab.dart';

/// The labels the bar shows before "⌄" (SelectionButton.tsx BAR), in the order of all of them.
const _bar = {
  QuickLabelId.looksGood,
  QuickLabelId.fire,
  QuickLabelId.clarify,
  QuickLabelId.verify,
  QuickLabelId.outOfScope,
};
const _chip = 44.0;
const _row = 48.0;
const _gap = 8.0;
const _quoteCut = 200;

/// The comment quote of a whole message: cut in the sheet only, the anchor keeps the whole text.
String _cut(String s) =>
    s.length <= _quoteCut ? s : '${s.substring(0, _quoteCut)}…';

/// The draft's quote of a message: `> line` for each line, then an empty line.
String replyQuote(FeedItem item) =>
    '${const LineSplitter().convert(chatRaw(item)).map((l) => '> $l').join('\n')}\n\n';

/// Opens the menu of [item] shown at [itemRect] (global). Completes when it closes. A message with no anchor source
/// (still streaming, a tool, a plan) opens nothing.
Future<void> showMessageMenu(
  BuildContext context, {
  required WindowTab tab,
  required FeedItem item,
  required Rect itemRect,
  required VoidCallback onSelectText,
  required void Function(String quote) onReply,
}) {
  final source = chatSource(item);
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (source == null || overlay == null) return Future.value();
  final done = Completer<void>();
  final route = ModalRoute.of(context);
  final back = _Back();
  late final OverlayEntry entry;
  var closed = false;
  void close() {
    if (closed) return;
    closed = true;
    route?.unregisterPopEntry(back);
    entry.remove();
    done.complete();
  }

  back.close = close;
  route?.registerPopEntry(back);
  // the menu belongs to its route: once another is pushed over it (a permission sheet), or this one or the message
  // is gone, the scrim must not stay. A frame follows each of those; look after it.
  void watch() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (closed) return;
      if (!context.mounted || (route != null && !route.isCurrent)) {
        close();
      } else {
        watch();
      }
    });
  }

  watch();
  HapticFeedback.selectionClick();
  entry = OverlayEntry(
    builder: (_) => _Menu(
      tab: tab,
      item: item,
      source: source,
      rect: itemRect,
      close: close,
      comment: () async {
        close();
        if (!context.mounted) return;
        final text = chatText(item).text;
        final res = await showCommentSheet(
          context,
          quote: _cut(text),
          tab: tab,
        );
        if (res is SheetSave) {
          tab.comments.add(
            makeAnchor(source, text, 0, text.length),
            res.text,
            res.label,
            voice: res.voice,
          );
        }
      },
      onSelectText: () {
        close();
        onSelectText();
      },
      onReply: (q) {
        close();
        onReply(q);
      },
    ),
  );
  overlay.insert(entry);
  return done.future;
}

class _Back extends PopEntry<Object?> {
  late final VoidCallback close;
  @override
  final ValueNotifier<bool> canPopNotifier = ValueNotifier(false);
  @override
  void onPopInvokedWithResult(bool didPop, Object? result) {
    // closing unregisters this entry, which the route is iterating over
    if (!didPop) scheduleMicrotask(close);
  }
}

class _Menu extends StatefulWidget {
  const _Menu({
    required this.tab,
    required this.item,
    required this.source,
    required this.rect,
    required this.close,
    required this.comment,
    required this.onSelectText,
    required this.onReply,
  });

  final WindowTab tab;
  final FeedItem item;
  final AnchorSource source;
  final Rect rect;
  final VoidCallback close;
  final VoidCallback comment;
  final VoidCallback onSelectText;
  final void Function(String quote) onReply;

  @override
  State<_Menu> createState() => _MenuState();
}

class _MenuState extends State<_Menu> {
  bool _all = false;

  void _label(QuickLabel l) {
    final text = chatText(widget.item).text;
    widget.tab.comments.add(
      makeAnchor(widget.source, text, 0, text.length),
      '',
      l.id,
    );
    widget.close();
  }

  Widget _labels(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    Widget chip(QuickLabel l) => Tooltip(
      message: l.textIn(lang),
      child: InkResponse(
        onTap: () => _label(l),
        radius: _chip / 2,
        child: SizedBox.square(
          dimension: _chip,
          child: Center(
            child: Text(l.emoji, style: const TextStyle(fontSize: 24)),
          ),
        ),
      ),
    );
    final shown = _all
        ? quickLabels
        : [
            for (final l in quickLabels)
              if (_bar.contains(l.id)) l,
          ];
    return _Panel(
      color: c.popover,
      border: c.border,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Flexible(
            child: Wrap(
              key: const ValueKey('labels'),
              children: [for (final l in shown) chip(l)],
            ),
          ),
          IconButton(
            key: const ValueKey('labels-more'),
            tooltip: t.labelsAll,
            visualDensity: VisualDensity.compact,
            constraints: const BoxConstraints.tightFor(
              width: _chip,
              height: _chip,
            ),
            padding: EdgeInsets.zero,
            color: c.mutedFg,
            icon: Icon(_all ? Icons.expand_less : Icons.expand_more),
            onPressed: () => setState(() => _all = !_all),
          ),
        ],
      ),
    );
  }

  Widget _menu(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    Widget entry(Widget icon, String label, VoidCallback onTap) => InkWell(
      onTap: onTap,
      child: SizedBox(
        height: _row,
        child: Row(
          children: [
            const SizedBox(width: 14),
            IconTheme.merge(
              data: IconThemeData(color: c.mutedFg, size: 20),
              child: icon,
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Text(label, style: TextStyle(color: c.foreground)),
            ),
          ],
        ),
      ),
    );
    return _Panel(
      color: c.popover,
      border: c.border,
      pad: 0,
      width: 220,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          entry(const NbIcon(NbGlyph.comments), t.menuComment, widget.comment),
          entry(
            const Icon(Icons.text_fields),
            t.menuSelectText,
            widget.onSelectText,
          ),
          entry(const NbIcon(NbGlyph.copy), t.menuCopy, () {
            Clipboard.setData(ClipboardData(text: chatRaw(widget.item)));
            widget.close();
          }),
          entry(
            const Icon(Icons.reply),
            t.menuReply,
            () => widget.onReply(replyQuote(widget.item)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final user = widget.item is UserItem;
    final top = mq.padding.top + _gap;
    final bottom = mq.size.height - mq.padding.bottom - _gap;
    final width = mq.size.width;
    // the bar's height: a row of chips, or the wrapped rows of all of them
    final perRow = math.max(
      1,
      ((width - 2 * _gap - 2 * 8 - _chip) / _chip).floor(),
    );
    final rows = _all ? (quickLabels.length / perRow).ceil() : 1;
    final barH = rows * _chip + 16;
    final menuH = 4 * _row;
    final room = bottom - top - barH - menuH - 2 * _gap;
    final msgH = math.min(widget.rect.height, math.max(room, _row));
    final barAbove = widget.rect.top - barH - _gap >= top;
    final blockH = barH + menuH + msgH + 2 * _gap;
    var y = barAbove ? widget.rect.top - barH - _gap : widget.rect.top;
    y = math.max(top, math.min(y, bottom - blockH));
    final align = user ? CrossAxisAlignment.end : CrossAxisAlignment.start;
    Widget aligned(Widget w) => Padding(
      padding: const EdgeInsets.symmetric(horizontal: _gap),
      child: Align(
        alignment: user ? Alignment.centerRight : Alignment.centerLeft,
        child: w,
      ),
    );
    final bar = aligned(_labels(context));
    final lifted = SizedBox(
      height: msgH,
      child: Padding(
        padding: EdgeInsets.only(
          left: widget.rect.left,
          right: width - widget.rect.right,
        ),
        child: ClipRect(
          child: SingleChildScrollView(
            // a long message scrolls inside the lift
            child: FeedItemView(widget.item),
          ),
        ),
      ),
    );
    return Material(
      type: MaterialType.transparency,
      child: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              key: const ValueKey('menu-scrim'),
              behavior: HitTestBehavior.opaque,
              onTap: widget.close,
              child: const ColoredBox(color: Color(0x99000000)),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            top: y,
            child: Column(
              crossAxisAlignment: align,
              children: [
                if (barAbove) ...[bar, const SizedBox(height: _gap), lifted],
                if (!barAbove) ...[lifted, const SizedBox(height: _gap), bar],
                const SizedBox(height: _gap),
                aligned(_menu(context)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({
    required this.color,
    required this.border,
    required this.child,
    this.pad = 8,
    this.width,
  });
  final Color color;
  final Color border;
  final Widget child;
  final double pad;
  final double? width;

  @override
  Widget build(BuildContext context) => Container(
    width: width,
    padding: EdgeInsets.all(pad),
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: border),
      boxShadow: const [BoxShadow(color: Color(0x55000000), blurRadius: 16)],
    ),
    child: ClipRRect(borderRadius: BorderRadius.circular(8), child: child),
  );
}
