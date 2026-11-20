// The chat's Markdown: GitHub-flavoured, with highlighted code blocks, KaTeX ($…$ and $$…$$) and Mermaid as images.
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import '../theme.dart';
import '../files/file_markdown.dart' show codeMarksAttr;
import 'audio_clip.dart';
import 'code.dart';
import 'embed.dart';
import 'markdown_syntax.dart';
import 'mermaid.dart';

export 'markdown_syntax.dart';

class _EmbedBuilder extends MarkdownElementBuilder {
  _EmbedBuilder(this.build);
  final Widget Function(String src) build;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element e,
    TextStyle? preferred,
    TextStyle? parent,
  ) => build(e.attributes['src']!);
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

/// The element builders of the chat's Markdown (code, math, diagrams), shared with the file view.
Map<String, MarkdownElementBuilder> markdownBuilders({
  void Function(String id)? onMark,
}) => {
  'pre': _PreBuilder(onMark),
  'math': _MathBuilder(display: false),
  'mathblock': _MathBuilder(display: true),
  'nbaudio': _EmbedBuilder(AudioClip.new),
  'nbimage': _EmbedBuilder((s) => EmbeddedMedia(s, video: false)),
  'nbvideo': _EmbedBuilder((s) => EmbeddedMedia(s, video: true)),
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
