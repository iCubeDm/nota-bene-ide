// The desktop's text anchors (web/src/anchors/resolve.ts, line for line): offsets into the "rendered text", with a
// quote and its context to find the place again when the text moved.
import 'package:markdown/markdown.dart' as md;
import 'package:nb_protocol/nb_protocol.dart';

export '../chat/markdown.dart' show parseMarkdown;

/// How much text before and after the quote an anchor keeps.
const anchorContext = 32;
const _fastContext = 8;

/// JavaScript's `slice`: the bounds are clamped instead of thrown on.
String _slice(String s, int start, [int? end]) {
  final a = start.clamp(0, s.length);
  final b = (end ?? s.length).clamp(a, s.length);
  return s.substring(a, b);
}

TextAnchor makeAnchor(AnchorSource source, String text, int start, int end) {
  if (start < 0 || end > text.length || start > end) {
    throw RangeError(
      'bad anchor range $start..$end for text of length ${text.length}',
    );
  }
  return TextAnchor(
    source: source,
    start: start,
    end: end,
    quote: text.substring(start, end),
    prefix: _slice(text, start - anchorContext, start),
    suffix: _slice(text, end, end + anchorContext),
  );
}

int _commonSuffix(String a, String b) {
  var n = 0;
  while (n < a.length &&
      n < b.length &&
      a[a.length - 1 - n] == b[b.length - 1 - n]) {
    n++;
  }
  return n;
}

int _commonPrefix(String a, String b) {
  var n = 0;
  while (n < a.length && n < b.length && a[n] == b[n]) {
    n++;
  }
  return n;
}

/// The stored offsets hold only while the text around them still reads as it did (see resolve.ts).
bool _offsetsHold(TextAnchor a, String text) {
  final start = a.start.toInt(), end = a.end.toInt();
  if (end > text.length || _slice(text, start, end) != a.quote) return false;
  final p = _slice(a.prefix, a.prefix.length - _fastContext);
  final s = _slice(a.suffix, 0, _fastContext);
  if (start < p.length ||
      _slice(text, start - p.length, start) != p ||
      _slice(text, end, end + s.length) != s) {
    return false;
  }
  if (a.prefix.length < anchorContext && start != a.prefix.length) return false;
  if (a.suffix.length < anchorContext && end + a.suffix.length != text.length) {
    return false;
  }
  return true;
}

({int start, int end})? resolveAnchor(TextAnchor a, String text) {
  final quote = a.quote;
  if (_offsetsHold(a, text))
    return (start: a.start.toInt(), end: a.end.toInt());
  if (quote.isEmpty) return null;
  final origin = a.start.toInt();
  var best = -1, bestScore = -1, count = 0;
  for (var i = text.indexOf(quote); i != -1; i = text.indexOf(quote, i + 1)) {
    count++;
    final score =
        _commonSuffix(a.prefix, _slice(text, i - a.prefix.length, i)) +
        _commonPrefix(
          a.suffix,
          _slice(text, i + quote.length, i + quote.length + a.suffix.length),
        );
    if (score > bestScore ||
        (score == bestScore && (i - origin).abs() < (best - origin).abs())) {
      best = i;
      bestScore = score;
    }
  }
  if (count == 0) return null;
  if (count > 1 && bestScore == 0) return null;
  return (start: best, end: best + quote.length);
}

/// One text node of the Markdown and where its characters land in the rendered text: `map[i]` is the rendered offset
/// before raw character `i` (`map.length == text.length + 1`), as text.ts maps a DOM text node.
class TextRun {
  TextRun(this.node, this.raw);

  final md.Node node;

  /// what the node shows: its text, or a math node's source as the desktop shows it (`$tex$`)
  final String raw;
  int start = -1;
  final map = <int>[];
}

class RenderedText {
  RenderedText(this.text, this.runs);

  /// the desktop's anchor text model (web/src/anchors/text.ts): whitespace runs as one space, block boundaries as a
  /// space, the ends trimmed
  final String text;
  final List<TextRun> runs;
}

// text.ts's BLOCKS; `mathblock` is a paragraph on the desktop, which shows `$$…$$` as text
const _blocks = {
  'p', 'li', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', //
  'tr', 'td', 'th', 'ul', 'ol', 'table', 'section', 'hr', 'br', 'mathblock',
};

// JavaScript's \s and the no-break space
final _ws = RegExp(r'[\s\u00a0\ufeff]');

/// marked unescapes a backslash before ASCII punctuation in the text around math, so `\,` reads `,` on the desktop
String _unescape(String tex) =>
    tex.replaceAllMapped(RegExp(r'''\\([!-/:-@\[-`{-~])'''), (m) => m[1]!);

/// The rendered text of [nodes] as the desktop builds it from its DOM. A mermaid block is skipped: the phone shows it
/// as a picture (the desktop's SVG labels are text there, so an anchor next to one is found again by its quote).
RenderedText renderedText(List<md.Node> nodes) {
  final runs = <TextRun>[];
  final b = StringBuffer();
  var len = 0;
  var last = ' '; // the last character written ('' before any)
  var pending = false;
  var any = false;

  void emit(String c) {
    b.write(c);
    len++;
    last = c;
    any = true;
  }

  void visitText(md.Node node, String data) {
    final run = TextRun(node, data);
    for (var i = 0; i < data.length; i++) {
      final c = data[i];
      if (_ws.hasMatch(c)) {
        run.map.add(len);
        if (!any || last == ' ') continue;
        if (run.start < 0) run.start = len;
        emit(' ');
        pending = false;
      } else {
        if (pending && any && last != ' ') emit(' ');
        pending = false;
        run.map.add(len);
        if (run.start < 0) run.start = len;
        emit(c);
      }
    }
    run.map.add(len);
    if (run.start < 0) run.start = len;
    runs.add(run);
  }

  void visit(md.Node n) {
    if (n is md.Text) return visitText(n, n.text);
    if (n is! md.Element) return;
    final tag = n.tag;
    if (tag == 'pre') {
      final code = n.children?.whereType<md.Element>().firstOrNull;
      if (code?.attributes['class'] == 'language-mermaid') return;
    }
    final block = _blocks.contains(tag);
    if (block) pending = true;
    if (tag == 'math') {
      visitText(n, '\$${_unescape(n.textContent)}\$');
    } else if (tag == 'mathblock') {
      visitText(n, '\$\$ ${_unescape(n.textContent)} \$\$');
    } else {
      for (final c in n.children ?? const <md.Node>[]) {
        visit(c);
      }
    }
    if (block) pending = true;
  }

  for (final n in nodes) {
    visit(n);
  }
  var text = b.toString();
  if (text.endsWith(' ')) text = text.substring(0, text.length - 1);
  final total = text.length;
  for (final r in runs) {
    if (r.start > total) r.start = total;
    for (var i = 0; i < r.map.length; i++) {
      if (r.map[i] > total) r.map[i] = total;
    }
  }
  return RenderedText(text, runs);
}
