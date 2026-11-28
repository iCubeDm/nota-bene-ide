// Code highlighted with the Darcula syntax tokens (highlight.js grammars, as the desktop), as spans: the feed's blocks,
// the code and diff views, and the message field's blocks.
import 'package:flutter/painting.dart';
import 'package:highlight/highlight.dart' show highlight, Node;

import '../theme.dart';

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
