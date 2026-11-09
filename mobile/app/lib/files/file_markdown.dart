// A Markdown file as the chat draws it, built from our own parse so the comments' ranges can be marked in it: each
// range of the rendered text (comments/anchor.dart) is split out of its text nodes and wrapped in a link to the mark,
// whose style paints it.
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

import '../chat/markdown.dart';
import '../comments/anchor.dart';
import '../theme.dart';

/// A range of the rendered text to paint, and what tapping it means.
typedef Mark = ({int start, int end, String id, bool sent});

const _markScheme = 'nbmark:';

/// Wraps each mark's characters of [r]'s runs in `a(nbmark|nbsent(text))`. Math and code blocks are not split: their
/// builders draw from the whole text, so a mark there is not painted (the comment itself is unaffected).
void wrapMarks(List<md.Node> nodes, RenderedText r, List<Mark> marks) {
  if (marks.isEmpty) return;
  final parents = <md.Node, md.Element>{};
  void index(md.Element e) {
    for (final c in e.children ?? const <md.Node>[]) {
      parents[c] = e;
      if (c is md.Element) index(c);
    }
  }

  final root = md.Element('root', nodes);
  index(root);
  bool inCode(md.Node n) {
    for (var p = parents[n]; p != null; p = parents[p]) {
      if (p.tag == 'pre') return true;
    }
    return false;
  }

  for (final run in r.runs) {
    final node = run.node;
    if (node is! md.Text || inCode(node)) continue;
    final raw = node.text;
    // raw boundaries where a mark starts or ends inside this node
    final cuts = <({int from, int to, Mark m})>[];
    for (final m in marks) {
      int? from, to;
      for (var i = 0; i < raw.length; i++) {
        final at = run.map[i], next = run.map[i + 1];
        if (next <= at) continue; // a collapsed space: it emits nothing
        if (at >= m.start && at < m.end) {
          from ??= i;
          to = i + 1;
        }
      }
      if (from != null) cuts.add((from: from, to: to!, m: m));
    }
    if (cuts.isEmpty) continue;
    cuts.sort((a, b) => a.from.compareTo(b.from));
    final parts = <md.Node>[];
    var pos = 0;
    for (final c in cuts) {
      if (c.from < pos) continue; // overlapping marks: the first one paints
      if (c.from > pos) parts.add(md.Text(raw.substring(pos, c.from)));
      parts.add(
        md.Element('a', [
          md.Element(c.m.sent ? 'nbsent' : 'nbmark', [
            md.Text(raw.substring(c.from, c.to)),
          ]),
        ])..attributes['href'] = '$_markScheme${c.m.id}',
      );
      pos = c.to;
    }
    if (pos < raw.length) parts.add(md.Text(raw.substring(pos)));
    final parent = parents[node]!;
    final at = parent.children!.indexOf(node);
    parent.children!
      ..removeAt(at)
      ..insertAll(at, parts);
  }
}

class FileMarkdown extends StatefulWidget {
  const FileMarkdown({
    super.key,
    required this.text,
    required this.marks,
    required this.onMark,
    required this.listenerAt,
  });

  final String text;
  final List<Mark> marks;
  final void Function(String id) onMark;

  /// The selection of top-level block [i] is reported to this notifier: an offset Flutter gives inside one block
  /// stays near the rendered one, where across the file code and bullets push it away.
  final SelectionListenerNotifier Function(int i) listenerAt;

  @override
  State<FileMarkdown> createState() => _FileMarkdownState();
}

class _FileMarkdownState extends State<FileMarkdown>
    implements MarkdownBuilderDelegate {
  final _recognizers = <GestureRecognizer>[];

  @override
  GestureRecognizer createLink(String text, String? href, String title) {
    final r = TapGestureRecognizer()
      ..onTap = () {
        if (href != null && href.startsWith(_markScheme)) {
          widget.onMark(href.substring(_markScheme.length));
        } else {
          openLink(href);
        }
      };
    _recognizers.add(r);
    return r;
  }

  @override
  TextSpan formatText(MarkdownStyleSheet styleSheet, String code) =>
      TextSpan(style: styleSheet.code, text: code);

  @override
  void dispose() {
    for (final r in _recognizers) {
      r.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();
    final c = Theme.of(context).extension<NbColors>()!;
    final sheet = markdownStyle(context);
    // the sheet's tag styles are a plain map: the marks' own tags join it (a link around a mark keeps the text colour)
    sheet.styles['nbmark'] = TextStyle(
      color: c.foreground,
      backgroundColor: c.accent.withValues(alpha: 0.28),
    );
    sheet.styles['nbsent'] = TextStyle(
      color: c.foreground,
      backgroundColor: c.border,
    );
    final nodes = parseMarkdown(widget.text);
    wrapMarks(nodes, renderedText(nodes), widget.marks);
    final builders = markdownBuilders();
    List<Widget> build(md.Node n) => MarkdownBuilder(
      delegate: this,
      selectable: false,
      styleSheet: sheet,
      imageDirectory: null,
      imageBuilder: null,
      checkboxBuilder: null,
      // a bullet is not text of the file: a selection across list items must match the rendered text
      bulletBuilder: (p) => SelectionContainer.disabled(
        child: Text(
          p.style == BulletStyle.unorderedList ? '•' : '${p.index + 1}.',
          textAlign: p.style == BulletStyle.unorderedList
              ? TextAlign.center
              : TextAlign.right,
          style: sheet.listBullet,
        ),
      ),
      builders: builders,
      paddingBuilders: const {},
      listItemCrossAxisAlignment: MarkdownListItemCrossAxisAlignment.baseline,
    ).build([n]);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (i, n) in nodes.indexed) ...[
          if (i > 0) SizedBox(height: sheet.blockSpacing),
          SelectionListener(
            selectionNotifier: widget.listenerAt(i),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: build(n),
            ),
          ),
        ],
      ],
    );
  }
}
