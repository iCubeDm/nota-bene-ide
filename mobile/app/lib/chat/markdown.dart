// The chat's Markdown: GitHub-flavoured, with highlighted code blocks, KaTeX ($…$ and $$…$$) and Mermaid as images.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import '../theme.dart';
import 'code.dart';
import 'mermaid.dart';

/// `$tex$`: no space just inside the dollars, no digit right after the closing one (so `$5 and $6` stays text).
class _InlineMath extends md.InlineSyntax {
  _InlineMath() : super(r'\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)');

  @override
  bool onMatch(md.InlineParser parser, Match m) {
    parser.addNode(md.Element.text('math', m[1]!));
    return true;
  }
}

/// `$$ … $$` on one line or across lines.
class _BlockMath extends md.BlockSyntax {
  @override
  RegExp get pattern => RegExp(r'^\s*\$\$');

  @override
  md.Node parse(md.BlockParser parser) {
    final lines = <String>[];
    var first = parser.current.content.trim().substring(2);
    if (first.endsWith(r'$$') && first.length >= 2) {
      parser.advance();
      return md.Element.text(
        'mathblock',
        first.substring(0, first.length - 2).trim(),
      );
    }
    lines.add(first);
    parser.advance();
    while (!parser.isDone) {
      final l = parser.current.content;
      parser.advance();
      final cut = l.indexOf(r'$$');
      if (cut >= 0) {
        lines.add(l.substring(0, cut));
        break;
      }
      lines.add(l);
    }
    return md.Element.text('mathblock', lines.join('\n').trim());
  }
}

class _MathBuilder extends MarkdownElementBuilder {
  _MathBuilder({required this.display});
  final bool display;

  @override
  bool isBlockElement() => display;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element e,
    TextStyle? preferred,
    TextStyle? parent,
  ) {
    final c = Theme.of(context).extension<NbColors>()!;
    final tex = e.textContent;
    final math = Math.tex(
      tex,
      mathStyle: display ? MathStyle.display : MathStyle.text,
      textStyle: parent ?? preferred,
      onErrorFallback: (_) => Text(
        display ? '\$\$$tex\$\$' : '\$$tex\$',
        style: TextStyle(color: c.destructive, fontFamily: 'monospace'),
      ),
    );
    if (!display) return math;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: math,
      ),
    );
  }
}

class _PreBuilder extends MarkdownElementBuilder {
  @override
  bool isBlockElement() => true;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element e,
    TextStyle? preferred,
    TextStyle? parent,
  ) {
    final code = e.children?.whereType<md.Element>().firstOrNull;
    final cls = code?.attributes['class'] ?? '';
    final lang = cls.startsWith('language-') ? cls.substring(9) : null;
    final text = e.textContent;
    if (lang == 'mermaid') return MermaidBlock(text);
    return CodeBlock(text, lang: lang);
  }
}

/// The syntaxes of the chat's Markdown, shared with the file view and its anchors.
final mathBlockSyntaxes = <md.BlockSyntax>[_BlockMath()];
final mathInlineSyntaxes = <md.InlineSyntax>[_InlineMath()];

/// [text] parsed as [NbMarkdown] parses it (flutter_markdown_plus: GitHub-flavoured, HTML not encoded).
List<md.Node> parseMarkdown(String text) => md.Document(
  blockSyntaxes: mathBlockSyntaxes,
  inlineSyntaxes: mathInlineSyntaxes,
  extensionSet: md.ExtensionSet.gitHubFlavored,
  encodeHtml: false,
).parseLines(const LineSplitter().convert(text));

class NbMarkdown extends StatelessWidget {
  const NbMarkdown(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final base = MarkdownStyleSheet.fromTheme(Theme.of(context));
    return MarkdownBody(
      data: text,
      extensionSet: md.ExtensionSet.gitHubFlavored,
      blockSyntaxes: mathBlockSyntaxes,
      inlineSyntaxes: mathInlineSyntaxes,
      builders: {
        'pre': _PreBuilder(),
        'math': _MathBuilder(display: false),
        'mathblock': _MathBuilder(display: true),
      },
      styleSheet: base.copyWith(
        a: TextStyle(color: c.link),
        code: TextStyle(
          fontFamily: 'monospace',
          backgroundColor: c.muted,
          color: c.foreground,
          fontSize: 13,
        ),
        blockquoteDecoration: BoxDecoration(
          border: Border(left: BorderSide(color: c.border, width: 3)),
        ),
      ),
      onTapLink: (text, href, title) {
        final u = href == null ? null : Uri.tryParse(href);
        if (u != null && (u.scheme == 'https' || u.scheme == 'http')) {
          launchUrl(u, mode: LaunchMode.externalApplication);
        }
      },
    );
  }
}
