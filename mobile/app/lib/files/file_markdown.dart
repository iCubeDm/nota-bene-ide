// A Markdown file as the chat draws it, built from our own parse so the comments' ranges can be marked in it: each
// range of the rendered text (comments/anchor.dart) is split out of its text nodes and wrapped in a link to the mark,
// whose style paints it.
import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

import '../chat/markdown.dart';
import '../comments/anchor.dart';
import '../theme.dart';

/// A range of the rendered text to paint, and what tapping it means. [n] > 0 puts the comment's number as a badge after
/// the first piece of the range (the chat); 0 paints only.
typedef Mark = ({int start, int end, String id, bool sent, int n});

const _markScheme = 'nbmark:';

/// The attribute of a `pre` element that carries the marks inside it: JSON `[[from, to, id, sent, n], …]`, offsets
/// into the block's text.
const codeMarksAttr = 'nbmarks';

/// The offset of text node [target] in [e]'s text, or -1.
int _offsetIn(md.Element e, md.Node target) {
  var at = 0;
  int walk(md.Node n) {
    if (identical(n, target)) return at;
    if (n is md.Text) {
      at += n.text.length;
    } else if (n is md.Element) {
      for (final c in n.children ?? const <md.Node>[]) {
        final r = walk(c);
        if (r >= 0) return r;
      }
    }
    return -1;
  }

  return walk(e);
}

/// Wraps each mark's characters of [r]'s runs in `a(nbmark|nbsent(text))`. A code block is not split: its builder
/// draws from the whole text, so the marks inside it go to the `pre` element as its [codeMarksAttr] (the builder
/// paints them and shows the badge in its bar). Math is not split either, so a mark there is not painted (the comment
/// itself is unaffected).
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
  md.Element? preOf(md.Node n) {
    for (var p = parents[n]; p != null; p = parents[p]) {
      if (p.tag == 'pre') return p;
    }
    return null;
  }

  final badged = <String>{};
  final inPre = <md.Element, List<List<Object>>>{};
  for (final run in r.runs) {
    final node = run.node;
    if (node is! md.Text) continue;
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
    final pre = preOf(node);
    if (pre != null) {
      final base = _offsetIn(pre, node);
      var end = 0;
      for (final c in cuts) {
        if (c.from < end) continue; // overlapping marks: the first one paints
        (inPre[pre] ??= []).add([
          base + c.from,
          base + c.to,
          c.m.id,
          c.m.sent ? 1 : 0,
          c.m.n > 0 && badged.add(c.m.id) ? c.m.n : 0,
        ]);
        end = c.to;
      }
      continue;
    }
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
          if (c.m.n > 0 && badged.add(c.m.id))
            md.Element.empty('nbbadge')
              ..attributes['id'] = c.m.id
              ..attributes['n'] = '${c.m.n}',
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
  for (final e in inPre.entries) {
    e.key.attributes[codeMarksAttr] = jsonEncode(e.value);
  }
}

/// A comment's number in a small accent circle, keyed `badge:<id>`; a tap opens the comment.
class MarkBadge extends StatelessWidget {
  const MarkBadge({super.key, required this.id, required this.n, this.onTap});
  final String id;
  final int n;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return GestureDetector(
      key: ValueKey('badge:$id'),
      onTap: onTap,
      child: Container(
        width: 18,
        height: 18,
        margin: const EdgeInsets.symmetric(horizontal: 2),
        alignment: Alignment.center,
        decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
        child: Text(
          '$n',
          style: TextStyle(
            color:
                ThemeData.estimateBrightnessForColor(c.accent) ==
                    Brightness.dark
                ? Colors.white
                : Colors.black,
            fontSize: 11,
            height: 1,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _BadgeBuilder extends MarkdownElementBuilder {
  _BadgeBuilder(this.onMark);
  final void Function(String id) onMark;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final id = element.attributes['id']!;
    return MarkBadge(
      id: id,
      n: int.parse(element.attributes['n']!),
      onTap: () => onMark(id),
    );
  }
}

/// Draws a list item's content itself, so that it can be wrapped (null: the package's own).
class _ItemBuilder extends MarkdownElementBuilder {
  _ItemBuilder(this.draw);
  final Widget? Function(md.Element item) draw;

  @override
  bool isBlockElement() => true;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element e,
    TextStyle? preferred,
    TextStyle? parent,
  ) => draw(e);
}

class FileMarkdown extends StatefulWidget {
  const FileMarkdown({
    super.key,
    required this.text,
    this.listenerAt,
    this.marks = const [],
    this.onMark = _noMark,
    this.parse = parseMarkdown,
    this.softLineBreak = false,
    this.wrapBlock,
    this.wrapItem,
    this.tapItem,
  });

  static void _noMark(String id) {}

  final String text;
  final List<Mark> marks;
  final void Function(String id) onMark;

  /// How [text] becomes nodes: the chat's Markdown, or a user message's (its HTML is text).
  final List<md.Node> Function(String text) parse;

  /// A line break of the text stays one (a user message).
  final bool softLineBreak;

  /// Dresses top-level block [i] (node [n], drawn as the given widget): the chat makes a reply's paragraphs targets.
  final Widget Function(int i, md.Node n, Widget block)? wrapBlock;

  /// Dresses list item [item] (its ordinal in document order, a parent before its nested items) of top-level block
  /// [block], a list: the item's own text and nested items, without its bullet. A list is then no block for [wrapBlock]
  /// to dress (the caller leaves it out there): its items are the targets.
  final Widget Function(int block, int item, Widget content, double bullet)?
  wrapItem;

  /// A tap on the bullet of such an item, which [wrapItem]'s widget does not hold.
  final void Function(int block, int item)? tapItem;

  /// The selection of top-level block [i] is reported to this notifier: an offset Flutter gives inside one block
  /// stays near the rendered one, where across the file code and bullets push it away. Null: nothing is reported.
  final SelectionListenerNotifier Function(int i)? listenerAt;

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
    // an item's content is drawn under a `section` (a block with no builder of its own, which would take the item's
    // text), in the item's text style
    sheet.styles['section'] = sheet.styles['li'];
    final nodes = widget.parse(widget.text);
    wrapMarks(nodes, renderedText(nodes), widget.marks);
    final builders = markdownBuilders(onMark: widget.onMark)
      ..['nbbadge'] = _BadgeBuilder(widget.onMark);
    // an item's content is drawn again by its own builder, where the chat wraps it: the Markdown package draws a list
    // item's bullet and content as one row, with no way to wrap the content alone
    final wrapItem = widget.wrapItem, tapItem = widget.tapItem;
    final bulletWidth = sheet.listIndent! + sheet.listBulletPadding!.horizontal;
    final itemOf =
        <md.Element, int>{}; // the items of the list being drawn, by element
    final drawn = <md.Element, Widget>{};
    var block = -1, bulletOf = -1;
    late final Map<String, MarkdownElementBuilder> withItems;
    List<Widget> build(md.Node n, {bool items = false}) => MarkdownBuilder(
      delegate: this,
      selectable: false,
      softLineBreak: widget.softLineBreak,
      styleSheet: sheet,
      imageDirectory: null,
      imageBuilder: null,
      checkboxBuilder: null,
      // a bullet is not text of the file: a selection across list items must match the rendered text
      bulletBuilder: (p) {
        final bullet = SelectionContainer.disabled(
          child: Text(
            p.style == BulletStyle.unorderedList ? '•' : '${p.index + 1}.',
            textAlign: p.style == BulletStyle.unorderedList
                ? TextAlign.center
                : TextAlign.right,
            style: sheet.listBullet,
          ),
        );
        final item = bulletOf;
        bulletOf = -1;
        final at = block;
        return item < 0 || tapItem == null
            ? bullet
            : GestureDetector(
                behavior: HitTestBehavior.opaque,
                excludeFromSemantics: true,
                onTap: () => tapItem(at, item),
                child: bullet,
              );
      },
      builders: items ? withItems : builders,
      paddingBuilders: const {},
      listItemCrossAxisAlignment: MarkdownListItemCrossAxisAlignment.baseline,
    ).build([n]);
    withItems = {
      ...builders,
      'li': _ItemBuilder((e) {
        final at = itemOf[e];
        if (at == null || wrapItem == null) return null;
        final content = drawn[e] ??= wrapItem(
          block,
          at,
          Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: build(md.Element('section', e.children), items: true),
          ),
          bulletWidth,
        );
        // after the content: a nested list's bullets, drawn with it, take theirs
        bulletOf = at;
        return content;
      }),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (i, n) in nodes.indexed) ...[
          if (i > 0) SizedBox(height: sheet.blockSpacing),
          () {
            block = i;
            final inList = wrapItem != null && isListNode(n);
            if (inList) {
              itemOf.clear();
              drawn.clear();
              for (final (k, li) in listItems(n).indexed) {
                itemOf[li] = k;
              }
            }
            final drawnBlock = Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: build(n, items: inList),
            );
            final wrap = widget.wrapBlock;
            final dressed = wrap == null ? drawnBlock : wrap(i, n, drawnBlock);
            final at = widget.listenerAt;
            return at == null
                ? dressed
                : SelectionListener(selectionNotifier: at(i), child: dressed);
          }(),
        ],
      ],
    );
  }
}
