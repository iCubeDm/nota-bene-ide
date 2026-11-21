// The chat's Markdown as nodes (issue 511): the syntaxes the chat, the file view and the anchors parse with, apart
// from the widgets that show them (markdown.dart), so the model files that read a reply's text need no screen.
import 'dart:convert';

import 'package:markdown/markdown.dart' as md;

import 'paths.dart';

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

/// `![](clips/take.mp3)`, `![](design/shot.png)`, `![](media/clip.mp4)`: a project's sound, image or video embedded
/// as an image is an `nbaudio`, `nbimage` or `nbvideo` element (a player, a preview, a tile, as on the desktop; issues
/// 452, 459); any other image, and anything on the web, stays an image.
class _EmbedSyntax extends md.ImageSyntax {
  @override
  md.Element createNode(
    String destination,
    String? title, {
    required List<md.Node> Function() getChildren,
  }) {
    final img = super.createNode(destination, title, getChildren: getChildren);
    final src = img.attributes['src']!;
    if (RegExp(r'^[a-z][a-z0-9+.-]*:', caseSensitive: false).hasMatch(src)) {
      return img;
    }
    // classified by the path alone: `shot.png?v=2` is an image (issue 459)
    final path = embedPath(src);
    final tag = soundPath.hasMatch(path)
        ? 'nbaudio'
        : switch (fileKindOf(path)) {
            FileKind.image => 'nbimage',
            FileKind.video => 'nbvideo',
            _ => null,
          };
    return tag == null ? img : (md.Element.empty(tag)..attributes['src'] = src);
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
final nbInlineSyntaxes = <md.InlineSyntax>[
  _InlineMath(),
  _InlineHtml(),
  _EmbedSyntax(),
];

/// [text] parsed as [NbMarkdown] parses it (flutter_markdown_plus: GitHub-flavoured, HTML not encoded).
List<md.Node> parseMarkdown(String text) => md.Document(
  blockSyntaxes: nbBlockSyntaxes,
  inlineSyntaxes: nbInlineSyntaxes,
  extensionSet: md.ExtensionSet.gitHubFlavored,
  encodeHtml: false,
).parseLines(const LineSplitter().convert(text));
