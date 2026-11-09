// The chat's Markdown: GitHub-flavoured, with highlighted code blocks, KaTeX ($…$ and $$…$$) and Mermaid as images.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import '../theme.dart';
import '../files/file_markdown.dart' show codeMarksAttr;
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

/// Raw HTML as the desktop shows it after DOMPurify: a tag or a comment shows nothing, `<br>` breaks the line.
class _InlineHtml extends md.InlineHtmlSyntax {
  @override
  bool onMatch(md.InlineParser parser, Match m) {
    parser.addNode(
      RegExp(r'^<br\s*/?>$', caseSensitive: false).hasMatch(m[0]!)
          ? md.Element.empty('br')
          : md.Text(''),
    );
    return true;
  }
}

/// An HTML block as the text it shows: tags and comments dropped (the lines inside are not Markdown, as on the desktop).
class _HtmlBlock extends md.HtmlBlockSyntax {
  @override
  md.Node parse(md.BlockParser parser) {
    final raw = super.parse(parser).textContent;
    final text = raw
        .replaceAll(RegExp(r'<!--[^]*?-->'), '')
        .replaceAll(RegExp(r'<[^>]*>'), '')
        .trim();
    return text.isEmpty ? md.Text('') : md.Element('p', [md.Text(text)]);
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
  _PreBuilder(this.onMark);
  final void Function(String id)? onMark;

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
    final raw = e.attributes[codeMarksAttr];
    return CodeBlock(
      text,
      lang: lang,
      ordinal: int.tryParse(e.attributes[codeOrdinalAttr] ?? ''),
      marks: raw == null ? const [] : codeMarksOf(raw),
      onMark: onMark,
    );
  }
}

/// The attribute of a `pre` element with its ordinal: which of the document's code blocks it is (0-based, a mermaid
/// diagram not counted, as the rendered text skips it). A block opened full screen names itself by it.
const codeOrdinalAttr = 'nbcode';

/// A document's count of code blocks so far: block syntaxes run in the document's order, one parse per document.
final _codeCount = Expando<int>('code blocks');

md.Node _numbered(md.BlockParser parser, md.Node n) {
  if (n is md.Element && n.tag == 'pre') {
    final code = n.children?.whereType<md.Element>().firstOrNull;
    if (code?.attributes['class'] != 'language-mermaid') {
      final i = _codeCount[parser.document] ?? 0;
      _codeCount[parser.document] = i + 1;
      n.attributes[codeOrdinalAttr] = '$i';
    }
  }
  return n;
}

class _FencedCode extends md.FencedCodeBlockSyntax {
  const _FencedCode();
  @override
  md.Node parse(md.BlockParser parser) =>
      _numbered(parser, super.parse(parser));
}

class _IndentedCode extends md.CodeBlockSyntax {
  const _IndentedCode();
  @override
  md.Node parse(md.BlockParser parser) =>
      _numbered(parser, super.parse(parser));
}

/// The code blocks' syntaxes: the library's own, each block marked with its ordinal.
const nbCodeSyntaxes = <md.BlockSyntax>[_FencedCode(), _IndentedCode()];

/// The syntaxes of the chat's Markdown (math, raw HTML, numbered code), shared with the file view and its anchors.
final nbBlockSyntaxes = <md.BlockSyntax>[
  _BlockMath(),
  _HtmlBlock(),
  ...nbCodeSyntaxes,
];
final nbInlineSyntaxes = <md.InlineSyntax>[_InlineMath(), _InlineHtml()];

/// [text] parsed as [NbMarkdown] parses it (flutter_markdown_plus: GitHub-flavoured, HTML not encoded).
List<md.Node> parseMarkdown(String text) => md.Document(
  blockSyntaxes: nbBlockSyntaxes,
  inlineSyntaxes: nbInlineSyntaxes,
  extensionSet: md.ExtensionSet.gitHubFlavored,
  encodeHtml: false,
).parseLines(const LineSplitter().convert(text));

/// The element builders of the chat's Markdown (code, math, diagrams), shared with the file view.
Map<String, MarkdownElementBuilder> markdownBuilders({
  void Function(String id)? onMark,
}) => {
  'pre': _PreBuilder(onMark),
  'math': _MathBuilder(display: false),
  'mathblock': _MathBuilder(display: true),
};

/// The chat's Markdown look in the current theme.
MarkdownStyleSheet markdownStyle(BuildContext context) {
  final c = Theme.of(context).extension<NbColors>()!;
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
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
  );
}

/// How a link leaves the app: the browser. Tests replace it.
@visibleForTesting
Future<bool> Function(Uri) launchLink = (u) =>
    launchUrl(u, mode: LaunchMode.externalApplication);

/// A link of the Markdown: only the web opens, in the browser.
void openLink(String? href) {
  final u = href == null ? null : Uri.tryParse(href);
  if (u != null && (u.scheme == 'https' || u.scheme == 'http')) {
    launchLink(u);
  }
}

class NbMarkdown extends StatelessWidget {
  const NbMarkdown(
    this.text, {
    super.key,
    this.blockSyntaxes,
    this.inlineSyntaxes,
    this.softLineBreak = false,
  });
  final String text;

  /// Instead of the chat's own (a user message: its HTML is text); null keeps them.
  final List<md.BlockSyntax>? blockSyntaxes;
  final List<md.InlineSyntax>? inlineSyntaxes;

  /// A line break of the text stays one (a user message).
  final bool softLineBreak;

  @override
  Widget build(BuildContext context) => MarkdownBody(
    data: text,
    extensionSet: md.ExtensionSet.gitHubFlavored,
    blockSyntaxes: blockSyntaxes ?? nbBlockSyntaxes,
    inlineSyntaxes: inlineSyntaxes ?? nbInlineSyntaxes,
    softLineBreak: softLineBreak,
    builders: markdownBuilders(),
    styleSheet: markdownStyle(context),
    onTapLink: (text, href, title) => openLink(href),
  );
}
