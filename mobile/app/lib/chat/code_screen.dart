// A code block full screen: black on the code background, line numbers beside the code, a pinch that scales the text
// and panning both ways (lines are never wrapped), selectable text, copy and close in the bar. The lines are built as
// they scroll (a file can be thousands of them), each of a fixed height under a horizontal scroll as wide as the
// longest.
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SelectionStatus;
import 'package:flutter/services.dart';
import 'dart:math' as math;
import 'package:markdown/markdown.dart' as md;
import 'package:nb_protocol/nb_protocol.dart'
    show AnchorSourceFile, CommentStatus, TextAnchor;

import '../comments/anchor.dart';
import '../comments/chat_anchor.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'code.dart';
import 'feed.dart';
import 'window_tab.dart';

/// Opens [code] full screen. With the [tab] and the [item] it belongs to, a selection in it can be commented.
void openCode(
  BuildContext context,
  String code,
  String? lang, {
  WindowTab? tab,
  FeedItem? item,
  int? ordinal,
}) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => CodeScreen(
        code: code,
        lang: lang,
        tab: tab,
        item: item,
        ordinal: ordinal,
      ),
    ),
  );
}

class CodeScreen extends StatefulWidget {
  const CodeScreen({
    super.key,
    required this.code,
    this.lang,
    this.tab,
    this.item,
    this.ordinal,
    this.filePath,
    this.title,
  });

  final String code;

  /// A project file's text: a selection becomes a comment on the file (the desktop's file anchors), not on a message.
  final String? filePath;

  /// Shown in the bar instead of the language (a file's name).
  final String? title;
  final String? lang;

  /// The window and the message the code is from: a selection becomes a comment on the message.
  final WindowTab? tab;
  final FeedItem? item;

  /// Which of the message's code blocks this is (0-based): the selection is looked for inside that one.
  final int? ordinal;

  @override
  State<CodeScreen> createState() => _CodeScreenState();
}

/// A line longer than this is not highlighted (the desktop's limit): one minified line would stall the screen.
const highlightLineMax = 2000;

/// [spans] (leaves covering a text) cut into the lines of that text.
List<List<TextSpan>> splitSpanLines(List<TextSpan> spans) {
  final lines = <List<TextSpan>>[[]];
  for (final s in spans) {
    final parts = (s.text ?? '').split('\n');
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) lines.add([]);
      if (parts[i].isNotEmpty) {
        lines.last.add(TextSpan(text: parts[i], style: s.style));
      }
    }
  }
  return lines;
}

class _CodeScreenState extends State<CodeScreen> {
  String _selected = '';
  double _zoom = 1;

  // two fingers on the screen scale the text; the pointers are only watched, so scrolling and selecting go on
  final _fingers = <int, Offset>{};
  double _span0 = 0, _zoom0 = 1;

  final _listeners = <int, SelectionListenerNotifier>{};

  late final String _text = widget.code.endsWith('\n')
      ? widget.code.substring(0, widget.code.length - 1)
      : widget.code;
  late final List<String> _lines = _text.split('\n');
  late final List<int> _starts = () {
    var at = 0;
    return [
      for (final l in _lines)
        () {
          final s = at;
          at += l.length + 1;
          return s;
        }(),
    ];
  }();
  late final int _longest = _lines.fold(0, (m, l) => math.max(m, l.length));

  // the highlighted lines, kept while the colours stay the same
  NbColors? _spansFor;
  List<List<TextSpan>> _spanLines = const [];

  /// The desktop's text of a code file: its whitespace runs as one space (a `pre` of the text).
  late final RenderedText _rendered = renderedText([
    md.Element('pre', [
      md.Element('code', [md.Text(widget.code)]),
    ]),
  ]);

  SelectionListenerNotifier _listenerAt(int i) =>
      _listeners.putIfAbsent(i, SelectionListenerNotifier.new);

  List<List<TextSpan>> _highlighted(NbColors c) {
    if (identical(_spansFor, c)) return _spanLines;
    // a long line is blanked for the highlighter (same length) and shown plain
    final source = _lines
        .map((l) => l.length > highlightLineMax ? ' ' * l.length : l)
        .join('\n');
    final lines = splitSpanLines(highlightSpans(source, widget.lang, c));
    _spanLines = [
      for (var i = 0; i < _lines.length; i++)
        _lines[i].length > highlightLineMax
            ? [TextSpan(text: _lines[i])]
            : i < lines.length
            ? lines[i]
            : [TextSpan(text: _lines[i])],
    ];
    _spansFor = c;
    return _spanLines;
  }

  /// The existing comments of a project file, resolved over the same rendered text, as ranges of the code's characters.
  List<CodeMark> _marks() {
    final tab = widget.tab, path = widget.filePath;
    if (tab == null || path == null || _rendered.runs.isEmpty) return const [];
    final r = _rendered, run = r.runs.first;
    final out = <CodeMark>[];
    var end = 0;
    final found = <({int from, int to, String id, bool sent})>[];
    for (final c in tab.comments.forFile(path)) {
      final a = c.anchor;
      if (a is! TextAnchor) continue;
      final at = resolveAnchor(a, r.text);
      if (at == null) continue;
      int? from, to;
      for (var i = 0; i < run.raw.length; i++) {
        final here = run.map[i];
        // a collapsed space emits nothing
        if (run.map[i + 1] <= here) continue;
        if (here >= at.start && here < at.end) {
          from ??= i;
          to = i + 1;
        }
      }
      if (from != null) {
        found.add((
          from: from,
          to: to!,
          id: c.id,
          sent: c.status == CommentStatus.sent,
        ));
      }
    }
    found.sort((a, b) => a.from.compareTo(b.from));
    for (final f in found) {
      if (f.from < end) continue; // overlapping: the first one paints
      out.add((start: f.from, end: f.to, id: f.id, sent: f.sent, n: 0));
      end = f.to;
    }
    return out;
  }

  /// Where the selection starts in the rendered text, as the code's characters map to it: the nearest place to look
  /// first when the same words occur again and again. Null when no line holds the selection.
  int? _hint() {
    final run = _rendered.runs.firstOrNull;
    if (run == null) return null;
    for (final i in _listeners.keys.toList()..sort()) {
      final l = _listeners[i]!;
      if (!l.registered || i >= _starts.length) continue;
      final range = l.selection.range;
      if (range == null || l.selection.status == SelectionStatus.none) {
        continue;
      }
      final raw = (_starts[i] + range.startOffset).clamp(0, run.map.length - 1);
      return run.map[raw];
    }
    return null;
  }

  Future<void> _commentFile(WindowTab tab, String path) async {
    final r = _rendered;
    final at = locateSelection(r, _selected, _hint());
    if (at == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context).commentNotPlaced)),
      );
      return;
    }
    final res = await showCommentSheet(
      context,
      quote: r.text.substring(at.start, at.end),
      tab: tab,
    );
    if (res is! SheetSave) return;
    tab.comments.add(
      makeAnchor(AnchorSourceFile(path: path), r.text, at.start, at.end),
      res.text,
      res.label,
      voice: res.voice,
    );
  }

  Future<void> _comment() async {
    final tab = widget.tab, item = widget.item;
    if (tab != null && widget.filePath != null) {
      return _commentFile(tab, widget.filePath!);
    }
    final source = item == null ? null : chatSource(item);
    final r = item == null ? null : chatText(item);
    if (tab == null || r == null || source == null) return;
    final ord = widget.ordinal;
    final block = ord == null
        ? locateSelection(r, _text, null)
        : chatCodeRange(item!, ord);
    // the selection's place in the block, near where its first line says it starts
    final at = locateSelection(
      r,
      _selected,
      block == null ? null : block.start + (_hint() ?? 0),
      within: block,
    );
    if (at == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context).commentNotPlaced)),
      );
      return;
    }
    final res = await showCommentSheet(
      context,
      quote: r.text.substring(at.start, at.end),
      tab: tab,
    );
    if (res is! SheetSave) return;
    tab.comments.add(
      makeAnchor(source, r.text, at.start, at.end),
      res.text,
      res.label,
      voice: res.voice,
    );
  }

  void _down(PointerDownEvent e) {
    _fingers[e.pointer] = e.position;
    if (_fingers.length == 2) {
      _span0 = (_fingers.values.first - _fingers.values.last).distance;
      _zoom0 = _zoom;
    }
  }

  void _move(PointerMoveEvent e) {
    if (!_fingers.containsKey(e.pointer)) return;
    _fingers[e.pointer] = e.position;
    if (_fingers.length != 2 || _span0 <= 0) return;
    final span = (_fingers.values.first - _fingers.values.last).distance;
    setState(() => _zoom = (_zoom0 * span / _span0).clamp(0.5, 3.0));
  }

  void _up(PointerEvent e) {
    _fingers.remove(e.pointer);
    _span0 = 0;
  }

  /// The lines, built as they scroll.
  Widget _code(BuildContext context, NbColors c) {
    final size = 13 * _zoom, height = size * 1.5;
    final style = TextStyle(
      fontFamily: 'monospace',
      fontSize: size,
      color: c.synText,
      height: 1.5,
    );
    final tp = TextPainter(
      text: TextSpan(text: 'M' * 100, style: style),
      textDirection: TextDirection.ltr,
    )..layout();
    final charW = tp.width / 100;
    tp.dispose();
    final gutter = '${_lines.length}'.length * charW;
    final width = 12 + gutter + 12 + _longest * charW + 24;
    final spans = _highlighted(c);
    final marks = _marks();
    final strut = StrutStyle(
      fontFamily: 'monospace',
      fontSize: size,
      height: 1.5,
      forceStrutHeight: true,
    );
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SizedBox(
        width: width,
        child: ListView.builder(
          padding: const EdgeInsets.symmetric(vertical: 12),
          itemExtent: height,
          itemCount: _lines.length,
          itemBuilder: (context, i) {
            final line = _lines[i];
            final from = _starts[i];
            // the marks' parts that fall in this line, as its own offsets
            final local = [
              for (final m in marks)
                if (m.start < from + line.length && m.end > from)
                  (
                    start: math.max(m.start - from, 0),
                    end: math.min(m.end - from, line.length),
                    id: m.id,
                    sent: m.sent,
                    n: 0,
                  ),
            ];
            return SelectionListener(
              selectionNotifier: _listenerAt(i),
              // the row may come out a little wider than the estimate of the scroll's width: it is not an error
              child: OverflowBox(
                alignment: Alignment.centerLeft,
                maxWidth: double.infinity,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const SizedBox(width: 12),
                    SelectionContainer.disabled(
                      child: SizedBox(
                        width: gutter,
                        child: Text(
                          '${i + 1}',
                          textAlign: TextAlign.end,
                          strutStyle: strut,
                          style: style.copyWith(color: c.mutedFg),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Text.rich(
                      TextSpan(
                        style: style,
                        children: paintMarks(spans[i], local, c),
                      ),
                      softWrap: false,
                      strutStyle: strut,
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final lang = widget.lang;
    final c = Theme.of(context).extension<NbColors>()!;
    final t = AppLocalizations.of(context);
    final count = _lines.length;
    return Scaffold(
      backgroundColor: c.codeBg,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                IconButton(
                  tooltip: MaterialLocalizations.of(context).closeButtonTooltip,
                  icon: NbIcon(NbGlyph.close, color: c.foreground),
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
                if (widget.title != null)
                  Flexible(
                    child: Text(
                      widget.title!,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: c.foreground, fontSize: 14),
                    ),
                  )
                else if (lang != null && lang.isNotEmpty)
                  Text(
                    lang,
                    style: TextStyle(color: c.foreground, fontSize: 14),
                  ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    t.codeLines(count),
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: c.mutedFg, fontSize: 12),
                  ),
                ),
                if (widget.tab != null &&
                    (widget.item != null || widget.filePath != null))
                  IconButton(
                    tooltip: t.comment,
                    icon: NbIcon(NbGlyph.comments, color: c.foreground),
                    onPressed: _selected.trim().isEmpty ? null : _comment,
                  ),
                IconButton(
                  tooltip: t.copy,
                  icon: NbIcon(NbGlyph.copy, color: c.foreground),
                  onPressed: () =>
                      Clipboard.setData(ClipboardData(text: _text)),
                ),
              ],
            ),
            Expanded(
              child: Listener(
                onPointerDown: _down,
                onPointerMove: _move,
                onPointerUp: _up,
                onPointerCancel: _up,
                child: SelectionArea(
                  onSelectionChanged: (s) =>
                      setState(() => _selected = s?.plainText ?? ''),
                  child: ListenableBuilder(
                    listenable: Listenable.merge([
                      if (widget.tab != null) widget.tab!.comments,
                    ]),
                    builder: (context, _) => _code(context, c),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
