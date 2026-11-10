// One file's diff full screen, unified: the old and new line numbers beside the code, added and removed lines tinted
// with the theme's tokens, no wrapping (a pinch scales the text, both ways pan; the rows are built as they scroll), selectable text, copy, and a comment on a
// selection anchored as the desktop's diff anchors it (web/src/vcs/DiffBody.tsx): the file's path (with the commit's
// short hash for a commit's diff) and the text of the code rows with the markers and numbers left out.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:nb_protocol/nb_protocol.dart' show AnchorSourceFile, TextAnchor;

import '../comments/strings.g.dart';
import '../chat/code.dart' show CodeMark, highlightSpans, paintMarks;
import '../chat/code_marks.dart';
import '../chat/code_screen.dart' show highlightLineMax;
import '../chat/window_tab.dart';
import '../comments/anchor.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../ui/pinch_scale.dart';
import 'git.dart';
import 'remote.dart';
import 'text_file_screen.dart' show ErrorRetry;

/// A diff of more rows than this waits for "Show anyway" (the desktop's limit).
const bigDiffRows = 3000;

/// Per-line highlighting is what a long diff pays for.
const highlightRows = 1500;

String? _extOf(String path) => RegExp(
  r'\.([a-z0-9]+)$',
  caseSensitive: false,
).firstMatch(path)?[1]?.toLowerCase();

class DiffScreen extends StatefulWidget {
  const DiffScreen({
    super.key,
    required this.tab,
    required this.file,
    required this.load,
    this.ref,
  });
  final WindowTab tab;
  final GitFile file;

  /// Reads the patch (the working diff's or a commit's).
  final Future<Patch> Function() load;

  /// The commit's short hash for a commit's diff: part of the comment's anchor source.
  final String? ref;

  @override
  State<DiffScreen> createState() => _DiffScreenState();
}

class _DiffScreenState extends State<DiffScreen> {
  Patch? _patch;
  ParsedPatch? _parsed;
  FilesError? _error;
  bool _force = false;
  String _selected = '';

  // the rows in one list (a hunk's head, then its rows), each row's start in the code text of the anchors
  List<_Entry> _entries = const [];
  RenderedText? _text;
  final _listeners = <int, SelectionListenerNotifier>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _patch = null;
      _parsed = null;
      _error = null;
    });
    Patch? patch;
    FilesError? error;
    try {
      patch = await widget.load();
    } on FilesError catch (e) {
      error = e;
    } on Object {
      error = FilesError(null);
    }
    if (!mounted) return;
    setState(() {
      _patch = patch;
      _parsed = patch == null ? null : parsePatch(patch.text);
      _index(_parsed);
      _error = error;
    });
  }

  /// The desktop's text of a diff: the code rows, each ending in a newline, whitespace as one space.
  void _index(ParsedPatch? p) {
    _listeners.clear();
    if (p == null) {
      _entries = const [];
      _text = null;
      return;
    }
    final entries = <_Entry>[];
    final code = StringBuffer();
    for (final h in p.hunks) {
      entries.add(_Entry.head(h.head));
      for (final r in h.rows) {
        entries.add(_Entry.row(r, code.length));
        code
          ..write(r.s)
          ..write('\n');
      }
    }
    _entries = entries;
    _text = renderedText([
      md.Element('pre', [
        md.Element('code', [md.Text(code.toString())]),
      ]),
    ]);
  }

  /// The comments already made on this diff (this file at this commit, or the working tree), over the same text.
  List<CodeMark> _marks() {
    final r = _text;
    if (r == null) return const [];
    return codeMarksFor(r, [
      for (final c in widget.tab.comments.forFile(widget.file.path))
        if (c.anchor case TextAnchor(
          source: AnchorSourceFile(:final ref),
        ) when ref == widget.ref)
          c,
    ]);
  }

  Future<void> _comment(ParsedPatch p) async {
    final r = _text;
    if (r == null) return;
    // the same lines may occur again: the place the selection starts is looked at first
    final hint = selectionHint(
      r,
      _listeners,
      (i) => _entries[i].start,
      _entries.length,
    );
    final at = locateSelection(r, _selected, hint);
    if (at == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context).commentNotPlaced)),
      );
      return;
    }
    final res = await showCommentSheet(
      context,
      quote: r.text.substring(at.start, at.end),
      tab: widget.tab,
    );
    if (res is! SheetSave) return;
    widget.tab.comments.add(
      makeAnchor(
        AnchorSourceFile(path: widget.file.path, ref: widget.ref),
        r.text,
        at.start,
        at.end,
      ),
      res.text,
      res.label,
      voice: res.voice,
    );
  }

  Widget _note(String text) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Text(text, textAlign: TextAlign.center),
    ),
  );

  Widget _body(BuildContext context, AppLocalizations t, NbColors c) {
    final lang = Localizations.localeOf(context).languageCode;
    final p = _parsed, patch = _patch, error = _error;
    if (error != null) {
      return Center(
        child: ErrorRetry(
          message: error.outside
              ? t.fileOutside
              : error.missing
              ? t.fileNotFound
              : t.fileUnreadable,
          onRetry: _load,
        ),
      );
    }
    if (p == null || patch == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (widget.file.binary || p.binary) return _note(webString('binary', lang));
    if (p.hunks.isEmpty) {
      return _note(
        patch.truncated
            ? webString('vcsTooBig', lang)
            : widget.file.status == 'A'
            ? webString('vcsEmptyFile', lang)
            : webString('vcsOnlyMeta', lang),
      );
    }
    if (p.size > bigDiffRows && !_force) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(batchTemplate('vcsBigDiff', lang, [p.size])),
            TextButton(
              onPressed: () => setState(() => _force = true),
              child: Text(webString('vcsShowAnyway', lang)),
            ),
          ],
        ),
      );
    }
    return Column(
      children: [
        if (patch.truncated)
          Padding(
            padding: const EdgeInsets.all(8),
            child: Text(
              webString('vcsTooBig', lang),
              style: TextStyle(color: c.accent),
            ),
          ),
        Expanded(
          child: PinchScale(
            builder: (context, zoom) => ListenableBuilder(
              listenable: widget.tab.comments,
              builder: (context, _) => _Rows(
                parsed: p,
                entries: _entries,
                marks: _marks(),
                listenerAt: (i) =>
                    _listeners.putIfAbsent(i, SelectionListenerNotifier.new),
                path: widget.file.path,
                zoom: zoom,
              ),
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final f = widget.file;
    final p = _parsed;
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
                Expanded(
                  child: Text(
                    f.old != null ? '${f.old} → ${f.path}' : f.path,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: c.foreground, fontSize: 14),
                  ),
                ),
                Text(
                  '+${p?.add ?? f.add ?? 0}',
                  style: TextStyle(color: c.synAdd, fontSize: 12),
                ),
                const SizedBox(width: 6),
                Text(
                  '−${p?.del ?? f.del ?? 0}',
                  style: TextStyle(color: c.synDel, fontSize: 12),
                ),
                IconButton(
                  tooltip: t.comment,
                  icon: NbIcon(NbGlyph.comments, color: c.foreground),
                  onPressed: p == null || _selected.trim().isEmpty
                      ? null
                      : () => _comment(p),
                ),
                IconButton(
                  tooltip: t.copy,
                  icon: NbIcon(NbGlyph.copy, color: c.foreground),
                  onPressed: _patch == null
                      ? null
                      : () => Clipboard.setData(
                          ClipboardData(text: _patch!.text),
                        ),
                ),
              ],
            ),
            Expanded(
              child: SelectionArea(
                onSelectionChanged: (s) {
                  final next = s?.plainText ?? '';
                  if ((next.trim().isEmpty) != (_selected.trim().isEmpty)) {
                    setState(() => _selected = next);
                  } else {
                    _selected = next;
                  }
                },
                child: _body(context, t, c),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Entry {
  _Entry.head(String this.head) : row = null, start = -1;
  _Entry.row(DiffRow this.row, this.start) : head = null;
  final String? head;
  final DiffRow? row;

  /// the row's first character in the code text
  final int start;
}

/// The rows: gutters (old and new numbers, the marker) that selection skips, and the code. Built as they scroll, each
/// of one height under a horizontal scroll as wide as the longest.
class _Rows extends StatelessWidget {
  const _Rows({
    required this.parsed,
    required this.entries,
    required this.marks,
    required this.listenerAt,
    required this.path,
    required this.zoom,
  });
  final ParsedPatch parsed;
  final List<_Entry> entries;
  final List<CodeMark> marks;
  final SelectionListenerNotifier Function(int i) listenerAt;
  final String path;
  final double zoom;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = parsed.size > highlightRows ? null : _extOf(path);
    final size = 13 * zoom, height = size * 1.5;
    final style = TextStyle(
      fontFamily: 'monospace',
      fontSize: size,
      color: c.synText,
      height: 1.5,
    );
    final strut = StrutStyle(
      fontFamily: 'monospace',
      fontSize: size,
      height: 1.5,
      forceStrutHeight: true,
    );
    final numStyle = style.copyWith(color: c.mutedFg.withValues(alpha: .7));
    // monospace: the widest line sets the width every row is tinted to
    final probe = TextPainter(
      text: TextSpan(text: 'M' * 100, style: style),
      textDirection: TextDirection.ltr,
    )..layout();
    final charW = probe.width / 100;
    probe.dispose();
    var longest = 0;
    var oMax = 0, nMax = 0;
    for (final h in parsed.hunks) {
      for (final r in h.rows) {
        if (r.s.length > longest) longest = r.s.length;
        if ((r.o ?? 0) > oMax) oMax = r.o!;
        if ((r.n ?? 0) > nMax) nMax = r.n!;
      }
      if (h.head.length > longest) longest = h.head.length;
    }
    final digits = '${oMax > nMax ? oMax : nMax}'.length;
    final gutter = digits * charW + 8;
    final width = gutter * 2 + charW * 2 + 8 + longest * charW + 24;
    Widget number(int? n) => SizedBox(
      width: gutter,
      child: Text(
        n == null ? '' : '$n',
        textAlign: TextAlign.end,
        strutStyle: strut,
        style: numStyle,
      ),
    );
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SizedBox(
        width: width,
        child: ListView.builder(
          padding: const EdgeInsets.only(bottom: 16),
          itemExtent: height,
          itemCount: entries.length,
          itemBuilder: (context, i) {
            final e = entries[i];
            final head = e.head;
            if (head != null) {
              return Container(
                color: c.primary.withValues(alpha: .12),
                padding: const EdgeInsets.symmetric(horizontal: 8),
                alignment: Alignment.centerLeft,
                child: SelectionContainer.disabled(
                  child: OverflowBox(
                    alignment: Alignment.centerLeft,
                    maxWidth: double.infinity,
                    child: Text(
                      head,
                      softWrap: false,
                      style: numStyle.copyWith(fontSize: 11 * zoom),
                    ),
                  ),
                ),
              );
            }
            final r = e.row!;
            // a line over the limit stays plain
            final spans = r.s.length > highlightLineMax
                ? [TextSpan(text: r.s)]
                : highlightSpans(r.s, lang, c);
            return SelectionListener(
              selectionNotifier: listenerAt(i),
              child: Container(
                color: switch (r.t) {
                  '+' => c.synAddBg,
                  '-' => c.synDelBg,
                  _ => null,
                },
                // the row may come out a little wider than the estimate of the scroll's width: it is not an error
                child: OverflowBox(
                  alignment: Alignment.centerLeft,
                  maxWidth: double.infinity,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SelectionContainer.disabled(
                        child: Row(
                          children: [
                            number(r.o),
                            number(r.n),
                            SizedBox(
                              width: charW * 2,
                              child: Text(
                                r.t == ' ' ? '' : r.t,
                                textAlign: TextAlign.center,
                                strutStyle: strut,
                                style: style.copyWith(
                                  color: r.t == '+' ? c.synAdd : c.synDel,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text.rich(
                        TextSpan(
                          style: style,
                          children: paintMarks(
                            spans,
                            marksInRow(marks, e.start, r.s.length),
                            c,
                          ),
                        ),
                        softWrap: false,
                        strutStyle: strut,
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
