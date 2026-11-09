// A fenced code block: highlighted with the Darcula syntax tokens (highlight.js grammars, as the desktop), scrollable
// sideways, with a copy button.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:highlight/highlight.dart' show highlight, Node;

import '../l10n/app_localizations.dart';
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

class CodeBlock extends StatelessWidget {
  const CodeBlock(this.code, {super.key, this.lang});

  final String code;
  final String? lang;

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
              IconButton(
                tooltip: t.copy,
                visualDensity: VisualDensity.compact,
                iconSize: 16,
                icon: const Icon(Icons.copy),
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
                children: highlightSpans(text, lang, c),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
