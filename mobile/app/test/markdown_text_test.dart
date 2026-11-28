// Live markdown in the phone's message field (issue 726): the rules of web/src/core/components/field/livePreview.ts and
// blockKeys.ts.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/markdown_text.dart';
import 'package:nb_app/theme.dart';

const base = TextStyle(fontSize: 14);
const c = NbColors.darcula;

void main() {
  late BuildContext ctx;

  Future<void> host(WidgetTester t) => t.pumpWidget(
    MaterialApp(
      theme: NbTheme.darcula.data,
      home: Builder(
        builder: (x) {
          ctx = x;
          return const SizedBox();
        },
      ),
    ),
  );

  TextSpan draw(
    String text, {
    int? caret,
    TextSelection? selection,
    TextRange composing = TextRange.empty,
    bool focused = true,
    bool shell = false,
  }) {
    final m = MarkdownText(shell: shell)
      ..value = TextEditingValue(
        text: text,
        selection:
            selection ?? TextSelection.collapsed(offset: caret ?? text.length),
        composing: composing,
      );
    return m.buildTextSpan(context: ctx, style: base, withComposing: focused);
  }

  testWidgets('the span has the text\'s characters at the same offsets', (
    t,
  ) async {
    await host(t);
    const texts = [
      '**a** b _c_ ~~d~~ `e` [f](https://example.com)',
      '- one\n* two\n1. three\n> four',
      '```ts\nlet a = 1;\n```\nafter',
      '```\nopen',
      'plain 😀 text',
    ];
    for (final text in texts) {
      for (var caret = 0; caret <= text.length; caret++) {
        // a caret, a selection up to it, and a composing word before it
        for (final s in [
          draw(text, caret: caret),
          draw(
            text,
            selection: TextSelection(baseOffset: 0, extentOffset: caret),
          ),
          draw(
            text,
            caret: caret,
            composing: TextRange(start: caret < 2 ? 0 : caret - 2, end: caret),
          ),
        ]) {
          final plain = s.toPlainText();
          expect(plain.length, text.length, reason: text);
          for (var i = 0; i < text.length; i++) {
            final same =
                plain[i] == text[i] ||
                (plain[i] == '•' && '-*+'.contains(text[i])) ||
                (plain[i] == '▎' && text[i] == '>');
            expect(same, isTrue, reason: '$text at $i');
          }
        }
      }
    }
  });

  testWidgets('a span\'s marks hide while the caret is outside it', (t) async {
    await host(t);
    expect(shown(draw('**a** b')), 'a b');
    expect(shown(draw('`x` and _y_ and ~~z~~ ')), 'x and y and z ');
    expect(shown(draw('[site](https://example.com) ')), 'site ');
    expect(styleAt(draw('**a** b'), 2).fontWeight, FontWeight.w600);
    expect(styleAt(draw('_y_ '), 1).fontStyle, FontStyle.italic);
    expect(styleAt(draw('~~z~~ '), 2).decoration, TextDecoration.lineThrough);
    expect(styleAt(draw('`x` '), 1).fontFamily, 'monospace');
    expect(styleAt(draw('[s](u) '), 1).color, c.link);
  });

  testWidgets('the marks show while the caret or the selection touches it', (
    t,
  ) async {
    await host(t);
    expect(shown(draw('**a** b', caret: 3)), '**a** b');
    expect(shown(draw('**a** b', caret: 5)), '**a** b');
    expect(
      shown(
        draw(
          'x **a** b',
          selection: const TextSelection(baseOffset: 0, extentOffset: 3),
        ),
      ),
      'x **a** b',
    );
    expect(shown(draw('[s](u) x', caret: 2)), '[s](u) x');
  });

  testWidgets('an unfocused field hides every mark', (t) async {
    await host(t);
    expect(shown(draw('**a** b', caret: 3, focused: false)), 'a b');
  });

  testWidgets('a hidden mark takes no width', (t) async {
    await host(t);
    double width(InlineSpan s) => (TextPainter(
      text: s,
      textDirection: TextDirection.ltr,
    )..layout()).width;
    expect(
      width(draw('**a**', focused: false)),
      width(const TextSpan(text: 'a', style: base)),
    );
  });

  testWidgets('no mark inside a word or before a space, and none in code', (
    t,
  ) async {
    await host(t);
    expect(shown(draw('snake_case_name ')), 'snake_case_name ');
    expect(shown(draw('a * b * c')), 'a * b * c');
    expect(shown(draw('`**x**` ')), '**x** ');
  });

  testWidgets(
    'the opening fence shows while the caret is in its block, the closing one while on its line',
    (t) async {
      await host(t);
      const text = '```ts\nlet a\n```\n';
      expect(shown(draw(text)), '\nlet a\n\n');
      expect(shown(draw(text, caret: 2)), '```ts\nlet a\n\n');
      // no arrow key on a phone: the language line is reached from the code
      expect(shown(draw(text, caret: 7)), '```ts\nlet a\n\n');
      expect(shown(draw(text, caret: 14)), '```ts\nlet a\n```\n');
      final code = styleAt(draw(text), 7);
      expect(code.fontFamily, 'monospace');
      expect(code.backgroundColor, c.muted);
    },
  );

  testWidgets('code in a block is highlighted by its fence\'s language', (
    t,
  ) async {
    await host(t);
    expect(styleAt(draw('```js\nlet a\n```\n'), 6).color, c.synKeyword);
    expect(styleAt(draw('```\nlet a\n```\n'), 4).color, isNot(c.synKeyword));
  });

  testWidgets('a fence with Windows line ends is a fence', (t) async {
    await host(t);
    const text = '```js\r\nlet a\r\n```\r\nx';
    expect(styleAt(draw(text), 7).color, c.synKeyword);
    expect(shown(draw(text)), '\nlet a\r\n\nx');
  });

  testWidgets(
    'an unclosed fence is a block to the end; marks after a closed one hide',
    (t) async {
      await host(t);
      expect(styleAt(draw('```\nopen', caret: 0), 5).fontFamily, 'monospace');
      expect(
        shown(draw('```\n**a**\n```\n**b**', caret: 0)),
        '```\n**a**\n\nb',
      );
    },
  );

  testWidgets('a list\'s bullet is drawn as one, a quote mark as a bar', (
    t,
  ) async {
    await host(t);
    expect(
      draw('- one\n* two\n1. three').toPlainText(),
      '• one\n• two\n1. three',
    );
    expect(draw('> four').toPlainText(), '▎ four');
    expect(draw('-x *y*', caret: 0).toPlainText(), '-x *y*');
  });

  testWidgets('a `!` draft is drawn as it is, a `!` comment as markdown', (
    t,
  ) async {
    await host(t);
    final s = draw('!ls **a** - b', shell: true);
    expect(s.toPlainText(), '!ls **a** - b');
    expect(leaves(s).every((l) => l.$2.fontWeight == null), isTrue);
    expect(shown(draw('!ls **a** b')), '!ls a b');
  });

  testWidgets('headings and tables stay plain', (t) async {
    await host(t);
    expect(shown(draw('# Title\n| a | b |')), '# Title\n| a | b |');
  });

  testWidgets('the composing range keeps its underline and hides nothing', (
    t,
  ) async {
    await host(t);
    final s = draw(
      '**a** b',
      caret: 7,
      composing: const TextRange(start: 0, end: 5),
    );
    expect(shown(s), '**a** b');
    expect(styleAt(s, 0).decoration, TextDecoration.underline);
    expect(styleAt(s, 6).decoration, isNot(TextDecoration.underline));
  });

  group('the block rules', () {
    /// [ch] typed at [at] (the end by default) of [text], [composing] the new value's.
    TextEditingValue type(
      String text,
      String ch, [
      int? at,
      TextRange composing = TextRange.empty,
      bool shell = false,
    ]) {
      final i = at ?? text.length;
      return MarkdownBlocks(shell: shell).formatEditUpdate(
        TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(offset: i),
        ),
        TextEditingValue(
          text: text.replaceRange(i, i, ch),
          selection: TextSelection.collapsed(offset: i + ch.length),
          composing: composing,
        ),
      );
    }

    (String, int) of(TextEditingValue v) => (v.text, v.selection.baseOffset);

    test('typing the third backtick at a line start closes the fence', () {
      expect(of(type('``', '`')), ('```\n\n```', 4));
      expect(of(type('say\n``', '`')), ('say\n```\n\n```', 8));
    });

    test('the closing fence of an open block is not closed again', () {
      expect(of(type('```\nab\n``', '`')), ('```\nab\n```', 10));
    });

    test('a backtick after text on the line is only a backtick', () {
      expect(of(type('a``', '`')), ('a```', 4));
    });

    test('a pasted or dictated text goes in as it is', () {
      expect(of(type('', '```')), ('```', 3));
      expect(of(type('- a', '\nb')), ('- a\nb', 5));
    });

    test('a newline inside a block is a newline', () {
      expect(of(type('```\nab\n```', '\n', 6)), ('```\nab\n\n```', 7));
      expect(of(type('```\n\n```', '\n', 4)), ('```\n\n\n```', 5));
      expect(of(type('```\n- a\n```', '\n', 7)), ('```\n- a\n\n```', 8));
    });

    test('a newline on an empty last line leaves the block', () {
      expect(of(type('```\nab\n\n```', '\n', 7)), ('```\nab\n```\n', 11));
      expect(of(type('```\nab\n\n```\nmore', '\n', 7)), (
        '```\nab\n```\nmore',
        11,
      ));
    });

    test('a newline on the opening fence goes into the block', () {
      expect(of(type('```js\nlet a\n```', '\n', 5)), ('```js\nlet a\n```', 6));
    });

    test('a newline on the opening fence of an empty block makes its line', () {
      expect(of(type('```ts\n```', '\n', 5)), ('```ts\n\n```', 6));
    });

    test('nothing happens while the keyboard composes', () {
      const word = TextRange(start: 2, end: 4);
      expect(of(type('- a', '\n', 3, word)), ('- a\n', 4));
      expect(of(type('``', '`', 2, const TextRange(start: 0, end: 3))), (
        '```',
        3,
      ));
    });

    test('a list number past nine digits is no item', () {
      const n = '99999999999999999999. a';
      expect(of(type(n, '\n')), ('$n\n', n.length + 1));
    });

    test('a fence with Windows line ends is a fence', () {
      expect(of(type('```js\r\nab\r\n```', '\n', 5)), (
        '```js\r\nab\r\n```',
        7,
      ));
    });

    test(
      'a newline continues a list or a quote and ends it on an empty item',
      () {
        expect(of(type('- a', '\n')), ('- a\n- ', 6));
        expect(of(type('- a\n- ', '\n')), ('- a\n', 4));
        expect(of(type('  * a', '\n')), ('  * a\n  * ', 10));
        expect(of(type('1. a', '\n')), ('1. a\n2. ', 8));
        expect(of(type('9) a', '\n')), ('9) a\n10) ', 9));
        expect(of(type('> q', '\n')), ('> q\n> ', 6));
        expect(of(type('> ', '\n')), ('', 0));
      },
    );

    test(
      'a newline inside an item\'s text takes the rest into the next item',
      () {
        expect(of(type('- ab', '\n', 3)), ('- a\n- b', 6));
      },
    );

    test('a newline elsewhere is a newline', () {
      expect(of(type('hi', '\n')), ('hi\n', 3));
    });

    test('a `!` draft has no block rules, a `!` comment has them', () {
      expect(of(type('!ls\n``', '`', null, TextRange.empty, true)), (
        '!ls\n```',
        7,
      ));
      expect(of(type('!- a', '\n', null, TextRange.empty, true)), (
        '!- a\n',
        5,
      ));
      expect(of(type('!ls\n``', '`')), ('!ls\n```\n\n```', 8));
    });
  });

  testWidgets('in a field: typing a fence closes it, and the field draws it', (
    t,
  ) async {
    final m = MarkdownText();
    await t.pumpWidget(
      MaterialApp(
        theme: NbTheme.darcula.data,
        home: Scaffold(
          body: TextField(
            controller: m,
            maxLines: 6,
            inputFormatters: const [MarkdownBlocks()],
          ),
        ),
      ),
    );
    await t.enterText(find.byType(TextField), '``');
    await t.enterText(find.byType(TextField), '```');
    expect(m.text, '```\n\n```');
    expect(m.selection.baseOffset, 4);
    await t.pump();
    expect(t.takeException(), isNull);
  });
}

/// The leaves of [s], each with the style it inherits.
List<(String, TextStyle)> leaves(InlineSpan s, [TextStyle up = base]) {
  if (s is! TextSpan) return const [];
  final own = up.merge(s.style);
  return [
    if (s.text != null) (s.text!, own),
    for (final ch in s.children ?? const <InlineSpan>[]) ...leaves(ch, own),
  ];
}

/// What can be seen of [s]: its text without the hidden (zero-size) leaves.
String shown(TextSpan s) => [
  for (final l in leaves(s))
    if (l.$2.fontSize != 0) l.$1,
].join();

/// The style of the character at [offset].
TextStyle styleAt(TextSpan s, int offset) {
  var at = 0;
  for (final l in leaves(s)) {
    if (offset < at + l.$1.length) return l.$2;
    at += l.$1.length;
  }
  throw RangeError.index(offset, s);
}
