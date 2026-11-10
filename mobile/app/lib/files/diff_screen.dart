// One file's diff full screen, unified: the old and new line numbers beside the code, added and removed lines tinted
// with the theme's tokens, no wrapping (a pinch zooms, both ways pan), selectable text, copy, and a comment on a
// selection anchored as the desktop's diff anchors it (web/src/vcs/DiffBody.tsx): the file's path (with the commit's
// short hash for a commit's diff) and the text of the code rows with the markers and numbers left out.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:nb_protocol/nb_protocol.dart' show AnchorSourceFile;

import '../comments/strings.g.dart';
import '../chat/code.dart' show highlightSpans;
import '../chat/window_tab.dart';
import '../comments/anchor.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
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
      _error = error;
    });
  }

  /// The desktop's text of a diff: the code rows, each ending in a newline, whitespace as one space.
  RenderedText _rendered(ParsedPatch p) => renderedText([
    md.Element('pre', [
      md.Element('code', [
        md.Text(
          [
            for (final h in p.hunks)
              for (final r in h.rows) '${r.s}\n',
          ].join(),
        ),
      ]),
    ]),
  ]);

  Future<void> _comment(ParsedPatch p) async {
    final r = _rendered(p);
    final at = locateSelection(r, _selected, null);
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
          child: _Rows(parsed: p, path: widget.file.path),
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

/// The rows: gutters (old and new numbers, the marker) that selection skips, and the code.
class _Rows extends StatelessWidget {
  const _Rows({required this.parsed, required this.path});
  final ParsedPatch parsed;
  final String path;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = parsed.size > highlightRows ? null : _extOf(path);
    final style = TextStyle(
      fontFamily: 'monospace',
      fontSize: 13,
      color: c.synText,
      height: 1.5,
    );
    final numStyle = style.copyWith(color: c.mutedFg.withValues(alpha: .7));
    // monospace: the widest line sets the width every row is tinted to
    final probe = TextPainter(
      text: TextSpan(text: 'M', style: style),
      textDirection: TextDirection.ltr,
    )..layout();
    final charW = probe.width;
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
        style: numStyle,
      ),
    );
    return InteractiveViewer(
      constrained: false,
      minScale: 0.5,
      maxScale: 3,
      child: SizedBox(
        width: width,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final h in parsed.hunks) ...[
              Container(
                width: width,
                color: c.primary.withValues(alpha: .12),
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: SelectionContainer.disabled(
                  child: Text(
                    h.head,
                    softWrap: false,
                    style: numStyle.copyWith(fontSize: 11),
                  ),
                ),
              ),
              for (final r in h.rows)
                Container(
                  width: width,
                  color: switch (r.t) {
                    '+' => c.synAddBg,
                    '-' => c.synDelBg,
                    _ => null,
                  },
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
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
                          children: highlightSpans(r.s, lang, c),
                        ),
                        softWrap: false,
                      ),
                    ],
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}
