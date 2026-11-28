// Live markdown in the message field (issue 726, the web's livePreview.ts and blockKeys.ts): the field's text stays the
// markdown that is sent; it is only drawn styled, its marks hidden while the caret is away from them. The span it draws
// has the text's characters at the same offsets (a hidden mark is drawn at zero size, a bullet's `-` as `•`), so the
// caret, the selection and the keyboard see the text as it is.
import 'dart:math' as math;

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

  /// ⇥ and ⇤ apply at the caret (not in a `!` draft).
  bool get canNest => !(shell && text.startsWith('!')) && nestable(value);

  /// ⇥ ([dir] 1) or ⇤ (-1) at the caret: one change of the value (see [nested]).
  void nest(int dir) => value = nested(value, dir);

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
/// empty last line leaves it; a newline continues a list or a quote, on an empty item ends it; Backspace on an empty
/// nested item takes it up a level (as Apple Notes and Google Docs do).
class MarkdownBlocks extends TextInputFormatter {
  const MarkdownBlocks({this.shell = false});

  /// A `!` text is a shell command: no rules.
  final bool shell;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue old,
    TextEditingValue now,
  ) {
    if (shell && old.text.startsWith('!')) return now;
    final back = _backspace(old, now);
    if (back != null) return back;
    final at = _typed(old, now);
    if (at == null) return now;
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

/// [now] is [old] with the character before its caret deleted (not the keyboard's word), the caret right after an
/// empty nested item's mark: the item up a level, else null.
TextEditingValue? _backspace(TextEditingValue old, TextEditingValue now) {
  final s = old.selection, at = s.baseOffset;
  if (!s.isValid || !s.isCollapsed || at == 0) return null;
  if (now.selection != TextSelection.collapsed(offset: at - 1) ||
      now.text != old.text.replaceRange(at - 1, at, '')) {
    return null;
  }
  final w = old.composing;
  if (w.isValid && w.start < at && at <= w.end) return null;
  final ls = _lineStart(old.text, at), le = _lineEnd(old.text, at);
  final m = _item.firstMatch(old.text.substring(ls, le));
  if (m == null || m[1]!.isEmpty || ls + m.end != at || at != le) return null;
  final was = _value(old.text, at);
  // a line in a code block is code
  return _nestLine(was)!.code ? null : nested(was, -1);
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

/// A code line's indent, as on the web.
const _codeIndent = '  ';

/// The spaces a line starts with (as the web counts them: a tab is no indent).
int _lead(String line) => _spaces.matchAsPrefix(line)!.end;

final _spaces = RegExp(' *');

bool _blank(String line) => line.trim().isEmpty;

/// The caret's line in [v], when it is a list item or a line in a code block (not a fence): its index and kind.
({int n, bool code})? _nestLine(TextEditingValue v) {
  final s = v.selection;
  if (!s.isValid) return null;
  final t = v.text;
  final ls = _lineStart(t, s.extentOffset);
  final code = _blocks(
    t,
  ).any((b) => b.open < ls && (b.close < 0 || ls < b.close));
  if (!code && _item.firstMatch(t.substring(ls, _lineEnd(t, ls))) == null) {
    return null;
  }
  return (n: '\n'.allMatches(t.substring(0, ls)).length, code: code);
}

/// ⇥ and ⇤ apply at [v]'s caret: it is on a list item or a line in a code block.
bool nestable(TextEditingValue v) => _nestLine(v) != null;

/// ⇥ ([dir] 1) and ⇤ (-1) on the caret's line, the web's Tab and Shift+Tab (issue 738, `indent` in blockKeys.ts): a
/// list item nests under the item above, at that item's text (so `1. ` nests by three), or goes back to its parent's
/// level, its children and its continued lines with it, the numbered lists around it numbered again; a line in a code
/// block gains or loses an indent. [v] itself when there is nowhere to go.
TextEditingValue nested(TextEditingValue v, int dir) {
  final at = _nestLine(v);
  if (at == null) return v;
  final lines = v.text.split('\n');
  final n = at.n, has = _lead(lines[n]);
  final to = at.code
      ? math.max(0, has + dir * _codeIndent.length)
      : dir > 0
      ? _nestUnder(lines, n, has)
      : _parentIndent(lines, n, has);
  if (to == null || to == has) return v;
  final moved = at.code ? [n] : _withChildren(lines, n, has);
  final starts = _starts(lines);
  final by = to - has;
  final out = _apply(v, [
    for (final l in moved)
      by > 0
          ? (starts[l], starts[l], ' ' * by)
          : (starts[l], starts[l] + math.min(-by, _lead(lines[l])), ''),
  ]);
  return at.code ? out : _apply(out, _renumber(out.text, n, moved.last));
}

/// Where each line starts.
List<int> _starts(List<String> lines) {
  final out = <int>[];
  var at = 0;
  for (final l in lines) {
    out.add(at);
    at += l.length + 1;
  }
  return out;
}

/// [v] with [edits] (from, to, the text put there; in order, apart) made, its selection kept on its text: a caret at an
/// insertion goes after it, one inside a replaced range to its end.
TextEditingValue _apply(TextEditingValue v, List<(int, int, String)> edits) {
  if (edits.isEmpty) return v;
  final b = StringBuffer();
  var done = 0;
  for (final (from, to, put) in edits) {
    b
      ..write(v.text.substring(done, from))
      ..write(put);
    done = to;
  }
  b.write(v.text.substring(done));
  int map(int p) {
    var d = 0;
    for (final (from, to, put) in edits) {
      if (p < from || (p == from && to > from)) break;
      if (p <= to) return from + d + put.length;
      d += put.length - (to - from);
    }
    return p + d;
  }

  final s = v.selection;
  return TextEditingValue(
    text: b.toString(),
    selection: s.copyWith(
      baseOffset: map(s.baseOffset),
      extentOffset: map(s.extentOffset),
    ),
  );
}

/// The item's line and the lines under it indented deeper (its children, its continued text), blank ones passed.
List<int> _withChildren(List<String> lines, int n, int own) {
  var end = n;
  for (var l = n + 1; l < lines.length; l++) {
    if (_blank(lines[l])) continue;
    if (_lead(lines[l]) <= own) break;
    end = l;
  }
  return [
    n,
    for (var l = n + 1; l <= end; l++)
      if (!_blank(lines[l])) l,
  ];
}

/// The text column of the nearest item above at the same level as [own] (blank, deeper and continued lines passed).
int? _nestUnder(List<String> lines, int n, int own) {
  for (var l = n - 1; l >= 0; l--) {
    if (_blank(lines[l])) continue;
    final m = _item.firstMatch(lines[l]);
    if (m != null && m[1]!.length == own) return m.end;
    if (_lead(lines[l]) <= own) return null;
  }
  return null;
}

/// The indent of the item above that [own] is nested in, else 0.
int? _parentIndent(List<String> lines, int n, int own) {
  if (own == 0) return null;
  for (var l = n - 1; l >= 0; l--) {
    if (_blank(lines[l])) continue;
    final m = _item.firstMatch(lines[l]);
    if (m != null && m[1]!.length < own) return m[1]!.length;
    if (m == null && _lead(lines[l]) < own) break;
  }
  return 0;
}

/// A list: its first line, its items' indent and kind (the bullet, or the number's `.` or `)`), its last item's text
/// column, the outermost list it is in, and its numbers (where each starts, and its digits).
class _List {
  _List(this.line, this.indent, this.kind, this.col, [_List? root]) {
    this.root = root ?? this;
  }
  final int line, indent;
  final String kind;
  int col;
  late final _List root;
  final numbers = <(int, String)>[];
}

/// The numbered lists of the outermost list around line [n], after lines [n]..[last] moved, numbered on from their
/// first item; a list the move began (its first item moved, or the first line after the moved ones) from 1.
List<(int, int, String)> _renumber(String text, int n, int last) {
  final lines = text.split('\n');
  final starts = _starts(lines);
  // a code block's lines are no items
  final code = <int>{};
  for (final b in _blocks(text)) {
    final end = b.close < 0 ? text.length : b.close;
    for (var l = 0; l < lines.length; l++) {
      if (starts[l] >= b.open && starts[l] <= end) code.add(l);
    }
  }
  final open = <_List>[], all = <_List>[];
  _List? top;
  for (var l = 0; l < lines.length; l++) {
    final line = lines[l];
    if (_blank(line)) continue;
    final m = code.contains(l) ? null : _item.firstMatch(line);
    if (m == null) {
      // a line outside the last item ends the lists it is not in
      while (open.isNotEmpty && open.last.col > _lead(line)) {
        open.removeLast();
      }
      continue;
    }
    final indent = m[1]!.length, kind = m[4] ?? m[2]!;
    _List? list;
    while (open.isNotEmpty) {
      final o = open.last;
      if (indent >= o.col) break;
      if (indent >= o.indent && kind == o.kind) {
        list = o;
        break;
      }
      open.removeLast();
    }
    if (list == null) {
      list = _List(l, indent, kind, m.end, open.firstOrNull?.root);
      open.add(list);
      all.add(list);
    }
    list.col = m.end;
    if (m[3] != null) list.numbers.add((starts[l] + indent, m[3]!));
    if (l == n) top = list.root;
  }
  var next = last + 1;
  while (next < lines.length && _blank(lines[next])) {
    next++;
  }
  final edits = <(int, int, String)>[];
  for (final list in all) {
    if (list.root != top || list.numbers.isEmpty) continue;
    final first = list.line;
    var k = first >= n && first <= next ? 1 : int.parse(list.numbers[0].$2);
    for (final (at, digits) in list.numbers) {
      final want = '${k++}';
      if (digits != want) edits.add((at, at + digits.length, want));
    }
  }
  return edits..sort((a, b) => a.$1.compareTo(b.$1));
}
