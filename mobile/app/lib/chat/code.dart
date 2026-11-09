// A fenced code block: highlighted with the Darcula syntax tokens (highlight.js grammars, as the desktop), scrollable
// sideways, with expand (full screen) and copy buttons.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:highlight/highlight.dart' show highlight, Node;

import '../files/file_markdown.dart' show MarkBadge;
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'code_screen.dart';
import 'comment_target.dart';

Color? _colorOf(String? cls, NbColors c) => switch (cls) {
  null => null,
  'keyword' ||
  'built_in' ||
  'selector-tag' ||
  'section' ||
  'bullet' ||
  'literal' ||
  'doctag' => c.synKeyword,
  'string' ||
  'regexp' ||
  'symbol' ||
  'template-variable' ||
  'link' => c.synString,
  'number' => c.synNumber,
  'comment' || 'quote' || 'meta' => c.synComment,
  'title' || 'function' || 'title.function' => c.synFunction,
  'type' || 'class' || 'title.class' => c.synType,
  'variable' || 'template-tag' => c.synVariable,
  'attr' ||
  'attribute' ||
  'property' ||
  'params' ||
  'selector-attr' ||
  'selector-class' => c.synProperty,
  'name' || 'tag' || 'selector-id' => c.synTag,
  'addition' => c.synAdd,
  'deletion' => c.synDel,
  _ => null,
};

List<TextSpan> highlightSpans(String code, String? lang, NbColors c) {
  if (lang == null || lang.isEmpty) return [TextSpan(text: code)];
  final List<Node> nodes;
  try {
    nodes = highlight.parse(code, language: lang).nodes ?? const [];
  } on Object {
    return [TextSpan(text: code)];
  }
  // flattened into leaves that carry their own colours, inherited from the enclosing scope where they have none
  final out = <TextSpan>[];
  void walk(Node n, Color? color, Color? bg) {
    final own = _colorOf(n.className, c) ?? color;
    final ownBg =
        switch (n.className) {
          'addition' => c.synAddBg,
          'deletion' => c.synDelBg,
          _ => null,
        } ??
        bg;
    if (n.value != null) {
      out.add(
        TextSpan(
          text: n.value,
          style: own == null && ownBg == null
              ? null
              : TextStyle(color: own, backgroundColor: ownBg),
        ),
      );
    }
    for (final ch in n.children ?? const <Node>[]) {
      walk(ch, own, ownBg);
    }
  }

  for (final n in nodes) {
    walk(n, null, null);
  }
  return out;
}

/// A comment's passage inside a code block: [start]..[end] of the block's text; [n] > 0 puts the comment's number in
/// the block's bar.
typedef CodeMark = ({int start, int end, String id, bool sent, int n});

/// The marks [wrapMarks] left on a `pre` element (its JSON attribute).
List<CodeMark> codeMarksOf(String json) => [
  for (final m in jsonDecode(json) as List)
    (
      start: (m as List)[0] as int,
      end: m[1] as int,
      id: m[2] as String,
      sent: m[3] == 1,
      n: m[4] as int,
    ),
];

/// [spans] (the leaves of [highlightSpans], covering the block's text from 0) with each mark's characters painted.
List<TextSpan> paintMarks(
  List<TextSpan> spans,
  List<CodeMark> marks,
  NbColors c,
) {
  if (marks.isEmpty) return spans;
  final out = <TextSpan>[];
  var at = 0;
  for (final s in spans) {
    final text = s.text ?? '';
    var i = 0;
    while (i < text.length) {
      // the next boundary of a mark after at + i
      var cut = text.length;
      CodeMark? in_;
      for (final m in marks) {
        if (m.start <= at + i && at + i < m.end) in_ ??= m;
        if (m.start > at + i) cut = cut < m.start - at ? cut : m.start - at;
        if (m.end > at + i) cut = cut < m.end - at ? cut : m.end - at;
      }
      final bg = in_ == null
          ? null
          : (in_.sent ? c.border : c.accent.withValues(alpha: 0.28));
      out.add(
        TextSpan(
          text: text.substring(i, cut),
          style: bg == null
              ? s.style
              : (s.style ?? const TextStyle()).copyWith(
                  backgroundColor: bg,
                  color: c.foreground,
                ),
        ),
      );
      i = cut;
    }
    at += text.length;
  }
  return out;
}

class CodeBlock extends StatelessWidget {
  const CodeBlock(
    this.code, {
    super.key,
    this.lang,
    this.ordinal,
    this.marks = const [],
    this.onMark,
  });

  final String code;
  final String? lang;

  /// Which of the message's code blocks this is (0-based), for a comment made from the full-screen view.
  final int? ordinal;

  /// Pending comments inside the block: their passages painted, their numbers in the bar (a tap calls [onMark]).
  final List<CodeMark> marks;
  final void Function(String id)? onMark;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final t = AppLocalizations.of(context);
    final text = code.endsWith('\n')
        ? code.substring(0, code.length - 1)
        : code;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: c.codeBg,
        border: Border.all(color: c.border),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const SizedBox(width: 10),
              Expanded(
                // the label is not the code: a selection across the block is the code alone
                child: SelectionContainer.disabled(
                  child: Text(
                    lang ?? '',
                    style: TextStyle(color: c.mutedFg, fontSize: 12),
                  ),
                ),
              ),
              for (final m in marks)
                if (m.n > 0)
                  MarkBadge(id: m.id, n: m.n, onTap: () => onMark?.call(m.id)),
              IconButton(
                tooltip: t.expandCode,
                visualDensity: VisualDensity.compact,
                icon: NbIcon(NbGlyph.expand, size: 16, color: c.mutedFg),
                onPressed: () {
                  final target = CommentTarget.maybeOf(context);
                  openCode(
                    context,
                    text,
                    lang,
                    tab: target?.tab,
                    item: target?.item,
                    ordinal: ordinal,
                  );
                },
              ),
              IconButton(
                tooltip: t.copy,
                visualDensity: VisualDensity.compact,
                icon: NbIcon(NbGlyph.copy, size: 16, color: c.mutedFg),
                onPressed: () => Clipboard.setData(ClipboardData(text: text)),
              ),
            ],
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
            child: Text.rich(
              TextSpan(
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 13,
                  color: c.synText,
                  height: 1.4,
                ),
                children: paintMarks(highlightSpans(text, lang, c), marks, c),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
