// Live markdown in the message field (issue 726, the web's livePreview.ts and blockKeys.ts): the field's text stays the
// markdown that is sent; it is only drawn styled, its marks hidden while the caret is away from them. The span it draws
// has the text's characters at the same offsets (a hidden mark is drawn at zero size, a bullet's `-` as `•`), so the
// caret, the selection and the keyboard see the text as it is.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';
import 'highlight.dart';

/// A fenced block: its opening fence's line [open]..[openEnd], its closing fence's line from [close] (-1: unclosed, to
/// the end of the text) to [closeEnd].
typedef _Block = ({
  int open,
  int openEnd,
  int close,
  int closeEnd,
  String lang,
});

// a line of a Windows text ends in `\r`
final _fence = RegExp(r'^ {0,3}(`{3,}|~{3,})(.*?)\r?$');

/// The fenced blocks of [text], in order.
List<_Block> _blocks(String text) {
  final out = <_Block>[];
  ({int open, int openEnd, String mark, String lang})? opened;
  for (var ls = 0; ls <= text.length;) {
    final nl = text.indexOf('\n', ls);
    final le = nl < 0 ? text.length : nl;
    final m = _fence.firstMatch(text.substring(ls, le));
    final o = opened;
    if (o == null) {
      // a backtick fence's info has no backtick
      if (m != null && !(m[1]![0] == '`' && m[2]!.contains('`'))) {
        final info = m[2]!.trim();
        opened = (
          open: ls,
          openEnd: le,
          mark: m[1]!,
          lang: info.isEmpty ? '' : info.split(RegExp(r'\s')).first,
        );
      }
    } else if (m != null &&
        m[1]![0] == o.mark[0] &&
        m[1]!.length >= o.mark.length &&
        m[2]!.trim().isEmpty) {
      out.add((
        open: o.open,
        openEnd: o.openEnd,
        close: ls,
        closeEnd: le,
        lang: o.lang,
      ));
      opened = null;
    }
    if (nl < 0) break;
    ls = nl + 1;
  }
  if (opened case final o?) {
    out.add((
      open: o.open,
      openEnd: o.openEnd,
      close: -1,
      closeEnd: -1,
      lang: o.lang,
    ));
  }
  return out;
}

/// A hidden mark: no size, no colour, no spacing of its own.
const _hidden = TextStyle(
  fontSize: 0,
  letterSpacing: 0,
  wordSpacing: 0,
  color: Color(0x00000000),
);

const _underline = TextStyle(decoration: TextDecoration.underline);

final _quote = RegExp(r'^ {0,3}(?:> ?)+');
// CommonMark's longest list number: nine digits
final _item = RegExp(r'^( *)([-*+]|(\d{1,9})([.)]))( +)');
final _escape = RegExp(r'\\[!-/:-@\[-`{-~]');
final _link = RegExp(r'\[([^\[\]\n]+)\]\(([^()\s]*)\)');

/// The emphasis kinds by their marks, the outer first (`**` is no `*` to the next kind).
final _spans = <(RegExp, int, TextStyle)>[
  (
    RegExp(r'~~(?![\s~])(.+?)(?<![\s~])~~'),
    2,
    const TextStyle(decoration: TextDecoration.lineThrough),
  ),
  (
    RegExp(r'\*\*(?![\s*])(.+?)(?<![\s*])\*\*'),
    2,
    const TextStyle(fontWeight: FontWeight.w600),
  ),
  (
    RegExp(
      r'(?<![\p{L}\p{N}_])__(?![\s_])(.+?)(?<![\s_])__(?![\p{L}\p{N}_])',
      unicode: true,
    ),
    2,
    const TextStyle(fontWeight: FontWeight.w600),
  ),
  (
    RegExp(r'\*(?![\s*])(.+?)(?<![\s*])\*'),
    1,
    const TextStyle(fontStyle: FontStyle.italic),
  ),
  (
    RegExp(
      r'(?<![\p{L}\p{N}_])_(?![\s_])(.+?)(?<![\s_])_(?![\p{L}\p{N}_])',
      unicode: true,
    ),
    1,
    const TextStyle(fontStyle: FontStyle.italic),
  ),
];

/// The message field's controller: its text drawn as markdown.
class MarkdownText extends TextEditingController {
  MarkdownText({super.text, this.shell = false});

  /// A `!` text is a shell command (the composer's), drawn as it is.
  final bool shell;

  /// The highlighted code of the last blocks, by language and code: moving the caret does not highlight it again.
  final _highlighted = <String, List<TextSpan>>{};
  NbColors? _colors;

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) {
    final c = Theme.of(context).extension<NbColors>();
    if (c == null || (shell && text.startsWith('!'))) {
      return super.buildTextSpan(
        context: context,
        style: style,
        withComposing: withComposing,
      );
    }
    if (c != _colors) _highlighted.clear();
    _colors = c;
    final composing = withComposing && value.isComposingRangeValid
        ? value.composing
        : TextRange.empty;
    // the composing flag is the field's focus: an unfocused field has no caret to show marks by
    final d = _Draw(text, withComposing ? selection : null, c, _highlight);
    return d.span(style, composing);
  }

  List<TextSpan> _highlight(String code, String lang, NbColors c) {
    final key = '$lang\n$code';
    final known = _highlighted[key];
    if (known != null) return known;
    if (_highlighted.length >= 8) _highlighted.remove(_highlighted.keys.first);
    return _highlighted[key] = highlightSpans(code, lang, c);
  }
}

/// What a text draws: styles over ranges, hidden ranges and characters drawn as others.
class _Draw {
  _Draw(this.text, this.sel, this.c, this.highlight) {
    final blocks = _blocks(text);
    var b = 0;
    for (var ls = 0; ls <= text.length;) {
      final nl = text.indexOf('\n', ls);
      final le = nl < 0 ? text.length : nl;
      while (b < blocks.length &&
          blocks[b].close >= 0 &&
          blocks[b].close < ls) {
        b++;
      }
      if (b < blocks.length && blocks[b].open <= ls) {
        _codeLine(blocks[b], ls, le);
      } else {
        _line(ls, le);
      }
      if (nl < 0) break;
      ls = nl + 1;
    }
    for (final block in blocks) {
      _code(block);
    }
  }

  final String text;
  final TextSelection? sel;
  final NbColors c;
  final List<TextSpan> Function(String code, String lang, NbColors c) highlight;

  final _styles = <(int, int, TextStyle)>[];
  final _hide = <(int, int)>[];
  final _swap = <int, String>{};

  late final _mono = TextStyle(
    fontFamily: 'monospace',
    backgroundColor: c.muted,
  );

  /// The caret or the selection touches [from]..[to].
  bool _touched(int from, int to) {
    final s = sel;
    return s != null && s.isValid && s.start <= to && s.end >= from;
  }

  void _style(int from, int to, TextStyle s) {
    if (to > from) _styles.add((from, to, s));
  }

  /// A line of a block: the opening fence shows while the caret is in the block (a phone has no arrow key to reach
  /// it), the closing one while the caret is on its line.
  void _codeLine(_Block b, int ls, int le) {
    final fence = ls == b.open || ls == b.close;
    if (!fence) return _style(ls, le, _mono);
    _style(ls, le, TextStyle(fontFamily: 'monospace', color: c.mutedFg));
    final end = ls == b.close ? le : (b.close < 0 ? text.length : b.closeEnd);
    if (!_touched(ls, end)) _hide.add((ls, le));
  }

  /// A block's code, highlighted by its fence's language.
  void _code(_Block b) {
    final from = b.openEnd + 1;
    final to = b.close < 0 ? text.length : b.close - 1;
    if (from > to) return;
    final code = text.substring(from, to);
    final spans = highlight(code, b.lang, c);
    var at = from;
    final styled = <(int, int, TextStyle)>[];
    for (final s in spans) {
      final n = s.text?.length ?? 0;
      if (s.style != null) styled.add((at, at + n, s.style!));
      at += n;
    }
    // a highlighter that does not give the code back as it is draws nothing
    if (at - from == code.length) {
      for (final s in styled) {
        _style(s.$1, s.$2, s.$3);
      }
    }
  }

  /// A line outside the blocks: its quote marks as bars, its bullet, then its spans.
  void _line(int ls, int le) {
    var start = ls;
    final line = text.substring(ls, le);
    final q = _quote.firstMatch(line);
    if (q != null) {
      for (var i = ls; i < ls + q.end; i++) {
        if (text[i] == '>') {
          _swap[i] = '▎';
          _style(i, i + 1, TextStyle(color: c.border));
        }
      }
      _style(ls + q.end, le, TextStyle(color: c.mutedFg));
      start = ls + q.end;
    }
    final m = _item.firstMatch(text.substring(start, le));
    if (m != null) {
      final mark = start + m[1]!.length;
      if (m[3] == null) _swap[mark] = '•';
      _style(mark, mark + m[2]!.length, TextStyle(color: c.mutedFg));
      start += m.end;
    }
    _inline(start, le);
  }

  /// Code, links and emphasis in [from]..[to]: each found is masked out of the line (`\0`) for the next kinds.
  void _inline(int from, int to) {
    var m = text.substring(from, to);
    void mask(int a, int b) => m = m.replaceRange(a, b, '\u0000' * (b - a));
    void span(int a, int e, int open, int close, TextStyle s) {
      _style(from + a + open, from + e - close, s);
      if (!_touched(from + a, from + e)) {
        _hide
          ..add((from + a, from + a + open))
          ..add((from + e - close, from + e));
      }
    }

    // code first: nothing inside it is a mark
    for (var i = 0; i < m.length;) {
      if (m[i] != '`') {
        i++;
        continue;
      }
      var j = i;
      while (j < m.length && m[j] == '`') {
        j++;
      }
      final n = j - i;
      int? close;
      for (var k = j; k < m.length;) {
        if (m[k] != '`') {
          k++;
          continue;
        }
        var e = k;
        while (e < m.length && m[e] == '`') {
          e++;
        }
        if (e - k == n) {
          close = k;
          break;
        }
        k = e;
      }
      if (close == null) {
        i = j;
        continue;
      }
      span(i, close + n, n, n, _mono.copyWith(color: c.foreground));
      mask(i, close + n);
      i = close + n;
    }
    for (final e in _escape.allMatches(m).toList()) {
      mask(e.start, e.end);
    }
    for (final l in _link.allMatches(m).toList()) {
      final textEnd = l.start + 1 + l[1]!.length;
      span(l.start, l.end, 1, l.end - textEnd, TextStyle(color: c.link));
      mask(l.start, l.start + 1);
      mask(textEnd, l.end);
    }
    for (final (re, n, style) in _spans) {
      for (final s in re.allMatches(m).toList()) {
        span(s.start, s.end, n, n, style);
        mask(s.start, s.start + n);
        mask(s.end - n, s.end);
      }
    }
  }

  /// The text cut where its styles change, each piece styled, hidden or swapped; never hidden inside [composing].
  TextSpan span(TextStyle? style, TextRange composing) {
    final cuts = <int>{0, text.length};
    for (final s in _styles) {
      cuts.addAll([s.$1, s.$2]);
    }
    for (final h in _hide) {
      cuts.addAll([h.$1, h.$2]);
    }
    for (final i in _swap.keys) {
      cuts.addAll([i, i + 1]);
    }
    if (composing.isValid) cuts.addAll([composing.start, composing.end]);
    final at = cuts.toList()..sort();
    final hidden = List.filled(text.length, false);
    for (final h in _hide) {
      hidden.fillRange(h.$1, h.$2, true);
    }
    // the styles that cover a piece, in the order they were added
    final order = List.generate(_styles.length, (i) => i)
      ..sort((x, y) => _styles[x].$1.compareTo(_styles[y].$1));
    final active = <int>[];
    var next = 0;
    final out = <TextSpan>[];
    for (var k = 0; k + 1 < at.length; k++) {
      final a = at[k], b = at[k + 1];
      if (a == b) continue;
      active.removeWhere((i) => _styles[i].$2 <= a);
      while (next < order.length && _styles[order[next]].$1 <= a) {
        if (_styles[order[next]].$2 > a) active.add(order[next]);
        next++;
      }
      active.sort();
      TextStyle? s;
      for (final i in active) {
        s = s?.merge(_styles[i].$3) ?? _styles[i].$3;
      }
      final composed =
          composing.isValid && a >= composing.start && b <= composing.end;
      if (composed) {
        s = s?.merge(_underline) ?? _underline;
      } else if (hidden[a]) {
        s = s?.merge(_hidden) ?? _hidden;
      }
      final swap = composed ? null : _swap[a];
      out.add(TextSpan(text: swap ?? text.substring(a, b), style: s));
    }
    return TextSpan(style: style, children: out);
  }
}

/// The block rules of the field, for one typed character only (a paste or a dictation goes in as it is): typing the
/// third backtick of a line opens a code block and closes it; a newline on a block's opening fence goes into it, on its
/// empty last line leaves it; a newline continues a list or a quote, on an empty item ends it.
class MarkdownBlocks extends TextInputFormatter {
  const MarkdownBlocks({this.shell = false});

  /// A `!` text is a shell command: no rules.
  final bool shell;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue old,
    TextEditingValue now,
  ) {
    final at = _typed(old, now);
    if (at == null || (shell && old.text.startsWith('!'))) return now;
    // the keyboard's own word (a voice "new line", a composed backtick) is the keyboard's
    final w = now.composing;
    if (w.isValid && w.start <= at && at < w.end) return now;
    final next = switch (now.text[at]) {
      '`' => _openFence(now.text, at),
      '\n' => _newline(old.text, at),
      _ => null,
    };
    return next ?? now;
  }
}

/// Where [now] is [old] with one character typed at its caret, else null.
int? _typed(TextEditingValue old, TextEditingValue now) {
  final s = old.selection, e = now.selection;
  if (!s.isValid || !s.isCollapsed || !e.isCollapsed) return null;
  final at = s.baseOffset;
  if (e.baseOffset != at + 1 || now.text.length != old.text.length + 1) {
    return null;
  }
  final same =
      now.text.startsWith(old.text.substring(0, at)) &&
      now.text.endsWith(old.text.substring(at));
  return same ? at : null;
}

TextEditingValue _value(String text, int caret) => TextEditingValue(
  text: text,
  selection: TextSelection.collapsed(offset: caret),
);

int _lineStart(String text, int at) =>
    at == 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1;

int _lineEnd(String text, int at) {
  final nl = text.indexOf('\n', at);
  return nl < 0 ? text.length : nl;
}

/// [text] with a backtick typed at [at]: a line of only ` ``` ` (not the close of an open block) gets its closing fence.
TextEditingValue? _openFence(String text, int at) {
  final ls = _lineStart(text, at);
  if (text.substring(ls, at + 1) != '```' || _lineEnd(text, at) != at + 1) {
    return null;
  }
  if (_blocks(text).any((b) => b.close == ls)) return null;
  return _value(text.replaceRange(at + 1, at + 1, '\n\n```'), at + 2);
}

/// [text] with a newline typed at [at].
TextEditingValue? _newline(String text, int at) {
  final ls = _lineStart(text, at), le = _lineEnd(text, at);
  for (final b in _blocks(text)) {
    if (ls < b.open || (b.close >= 0 && ls > b.close)) continue;
    if (b.close < 0 || ls == b.close) return null;
    if (ls == b.open) {
      // an empty block gets its line, else the next character would go on the closing fence
      if (b.close == b.openEnd + 1) {
        return _value(text.replaceRange(b.close, b.close, '\n'), b.close);
      }
      return _value(text, b.openEnd + 1);
    }
    // the empty last line after some code: it goes, the caret after the block
    if (ls == le && le + 1 == b.close && ls > b.openEnd + 1) {
      var next = text.replaceRange(ls - 1, le, '');
      final end = b.closeEnd - 1;
      if (end == next.length) next += '\n';
      return _value(next, end + 1);
    }
    return null;
  }
  final line = text.substring(ls, le);
  final q = _quote.firstMatch(line);
  final m = q ?? _item.firstMatch(line);
  if (m == null) return null;
  if (line.substring(m.end).trim().isEmpty) {
    return _value(text.replaceRange(ls, le, ''), ls);
  }
  if (at < ls + m.end) return null;
  final cont = q != null
      ? q[0]!
      : m[3] == null
      ? m[0]!
      : '${m[1]}${int.parse(m[3]!) + 1}${m[4]}${m[5]}';
  return _value(text.replaceRange(at, at, '\n$cont'), at + 1 + cont.length);
}
