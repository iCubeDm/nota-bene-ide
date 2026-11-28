// Live markdown in the phone's message field (issue 726): the rules of web/src/core/components/field/livePreview.ts and
// blockKeys.ts.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/markdown_text.dart';
import 'package:nb_app/chat/nest_buttons.dart';
import 'package:nb_app/main.dart';
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

    test('a backtick the keyboard composes is only a backtick', () {
      expect(of(type('``', '`', 2, const TextRange(start: 0, end: 3))), (
        '```',
        3,
      ));
    });

    /// The keyboard's Enter in one update with its word: [old] the word composing at the caret's end, [word] what it
    /// commits in its place, then the newline.
    TextEditingValue commit(String text, int from, String word) {
      final i = text.length;
      final now = text.replaceRange(from, i, '$word\n');
      return const MarkdownBlocks().formatEditUpdate(
        TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(offset: i),
          composing: TextRange(start: from, end: i),
        ),
        TextEditingValue(
          text: now,
          selection: TextSelection.collapsed(offset: now.length),
        ),
      );
    }

    test('Enter with the keyboard\'s word continues the list (issue 738)', () {
      // the word as it was, corrected, or a suggestion with its space
      expect(of(commit('- a\n  - два', 8, 'два')), ('- a\n  - два\n  - ', 16));
      expect(of(commit('- a\n  - ldf', 8, 'два')), ('- a\n  - два\n  - ', 16));
      expect(of(commit('- a\n  - дв', 8, 'два ')), ('- a\n  - два \n  - ', 17));
      // the newline still composing, as a voice "new line"
      const word = TextRange(start: 2, end: 4);
      expect(of(type('- a', '\n', 3, word)), ('- a\n- ', 6));
      expect(of(type('  - b', '\n', null, word)), ('  - b\n  - ', 10));
    });

    test('a pasted text ending in a newline goes in as it is', () {
      expect(of(type('- a', 'b\n')), ('- ab\n', 5));
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

    /// Backspace at [at] (the end by default) of [text], [composing] the old value's.
    TextEditingValue back(
      String text, [
      int? at,
      TextRange composing = TextRange.empty,
    ]) {
      final i = at ?? text.length;
      return const MarkdownBlocks().formatEditUpdate(
        TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(offset: i),
          composing: composing,
        ),
        TextEditingValue(
          text: text.replaceRange(i - 1, i, ''),
          selection: TextSelection.collapsed(offset: i - 1),
        ),
      );
    }

    test('Backspace on an empty nested item takes it up a level', () {
      expect(of(back('- a\n  - b\n    - ')), ('- a\n  - b\n  - ', 14));
      expect(of(back('1. a\n   - ')), ('1. a\n- ', 7));
    });

    test('Backspace on an empty nested item with Windows line ends', () {
      expect(of(back('- a\r\n  - \r\n- c', 9)), ('- a\r\n- \r\n- c', 7));
    });

    test('Backspace elsewhere deletes as it does', () {
      expect(of(back('- a\n- ')), ('- a\n-', 5));
      expect(of(back('- a\n  - b')), ('- a\n  - ', 8));
      expect(of(back('- a\n  - x', 8)), ('- a\n  -x', 7));
      expect(of(back('```\n  - \n```', 8)), ('```\n  -\n```', 7));
      expect(of(back('- a\n  - ', null, const TextRange(start: 7, end: 8))), (
        '- a\n  -',
        7,
      ));
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

  group('⇥ and ⇤ (the web\'s Tab and Shift+Tab)', () {
    TextEditingValue at(String text, [int? caret]) => TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: caret ?? text.length),
    );
    (String, int) of(TextEditingValue v) => (v.text, v.selection.baseOffset);

    test('an item nests under the one above and goes back out', () {
      final v = nested(at('- a\n- b'), 1);
      expect(of(v), ('- a\n  - b', 9));
      expect(of(nested(v, -1)), ('- a\n- b', 7));
    });

    test('a numbered item nests under its number\'s width', () {
      expect(nested(at('1. a\n2. b'), 1).text, '1. a\n   1. b');
    });

    test('with nowhere to go nothing changes; plain text and fences are not '
        'nestable', () {
      for (final (v, dir) in [
        (at('- a'), 1),
        (at('- a'), -1),
        (at('- a\n  - b\n    - '), 1),
        (at('```\nab\n```', 5), -1),
      ]) {
        expect(nestable(v), isTrue);
        expect(nested(v, dir), same(v));
      }
      expect(nestable(at('hi')), isFalse);
      expect(nestable(at('```\nab\n```', 2)), isFalse);
      expect(nestable(at('```\nab\n```', 9)), isFalse);
      expect(nested(at('hi'), 1).text, 'hi');
    });

    test('a code line gains and loses an indent, the caret past it', () {
      final v = nested(at('```\nab\n```', 5), 1);
      expect(of(v), ('```\n  ab\n```', 7));
      expect(of(nested(v, -1)), ('```\nab\n```', 5));
      expect(of(nested(at('```\nmain() {\n\n}\n```', 13), 1)), (
        '```\nmain() {\n  \n}\n```',
        15,
      ));
    });

    test('a numbered item nested starts its own list at 1, the list it left '
        'numbered on; out again, back in sequence', () {
      final v = nested(at('1. a\n2. b\n3. c\n4. d', 12), 1);
      expect(v.text, '1. a\n2. b\n   1. c\n3. d');
      expect(nested(v, -1).text, '1. a\n2. b\n3. c\n4. d');
    });

    test('an item taken out of the middle of a nested list leaves the ones '
        'after it as its own list from 1', () {
      expect(
        nested(at('1. a\n   1. b\n   2. c\n   3. d', 16), -1).text,
        '1. a\n   1. b\n2. c\n   1. d',
      );
    });

    test('an item moves with its children', () {
      final v = nested(at('- a\n- b\n  - c', 7), 1);
      expect(v.text, '- a\n  - b\n    - c');
      expect(nested(v, -1).text, '- a\n- b\n  - c');
    });

    test('an item nests over a blank line or a continuation line above', () {
      expect(nested(at('- a\n  more\n- b'), 1).text, '- a\n  more\n  - b');
      expect(nested(at('- a\n\n- b'), 1).text, '- a\n\n  - b');
    });

    test('the caret and the selection stay on their text', () {
      expect(of(nested(at('- a\n- bc', 7), 1)), ('- a\n  - bc', 9));
      final s = nested(
        const TextEditingValue(
          text: '- a\n- bc',
          selection: TextSelection(baseOffset: 6, extentOffset: 8),
        ),
        1,
      ).selection;
      expect((s.baseOffset, s.extentOffset), (8, 10));
    });

    test('a list somewhere else is not numbered again', () {
      expect(
        nested(at('1. x\n1. y\n\npara\n\n- a\n- b'), 1).text,
        '1. x\n1. y\n\npara\n\n- a\n  - b',
      );
    });
  });

  testWidgets('⇤ and ⇥ show while the field is focused and one of them can '
      'act; ⇥ nests, the field keeps its focus, an off one is off for '
      'TalkBack too', (t) async {
    final m = MarkdownText();
    final focus = FocusNode();
    addTearDown(() {
      m.dispose();
      focus.dispose();
    });
    await t.pumpWidget(
      NbApp(
        home: Scaffold(
          body: Column(
            children: [
              NestButtons(text: m, focus: focus),
              TextField(controller: m, focusNode: focus, maxLines: 6),
            ],
          ),
        ),
      ),
    );
    final indent = find.byKey(const ValueKey('nest-in'));
    final outdent = find.byKey(const ValueKey('nest-out'));
    Future<void> type(String text, [int? caret]) async {
      m.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: caret ?? text.length),
      );
      await t.pump();
    }

    await t.tap(find.byType(TextField));
    await type('hi');
    expect(focus.hasFocus, isTrue);
    expect(indent, findsNothing);
    // a first item with nothing above: neither can act
    await type('- a');
    expect(indent, findsNothing);
    await type('- a\n- b');
    expect(indent, findsOneWidget);
    expect(outdent, findsOneWidget);
    bool? enabled(Finder f) => t
        .widget<Semantics>(
          find.ancestor(of: f, matching: find.byType(Semantics)).first,
        )
        .properties
        .enabled;
    expect(enabled(outdent), isFalse);
    expect(enabled(indent), isTrue);
    await t.tap(indent);
    await t.pump();
    expect(m.text, '- a\n  - b');
    expect(m.selection.baseOffset, 9);
    expect(focus.hasFocus, isTrue);
    await t.tap(outdent);
    await t.pump();
    expect(m.text, '- a\n- b');
    expect(t.widget<IconButton>(outdent).onPressed, isNull);
    await type('```\nab\n```', 5);
    expect(indent, findsOneWidget);
    await type('- a\n- b\nplain');
    expect(indent, findsNothing);
    await type('- a\n- b');
    focus.unfocus();
    await t.pump();
    expect(indent, findsNothing);
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
