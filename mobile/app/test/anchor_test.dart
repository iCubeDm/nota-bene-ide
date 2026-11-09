// resolve.test.ts of the web, case for case: the phone's anchors must behave as the desktop's.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/anchor.dart';
import 'package:nb_protocol/nb_protocol.dart';

const src = AnchorSourceMessage(id: 'm1');

TextAnchor anchor(
  int start,
  int end,
  String quote,
  String prefix,
  String suffix,
) => TextAnchor(
  source: src,
  start: start,
  end: end,
  quote: quote,
  prefix: prefix,
  suffix: suffix,
);

void main() {
  group('makeAnchor', () {
    test('fills quote, prefix and suffix, clipped at the bounds', () {
      final a = makeAnchor(src, 'hello brave new world', 6, 11);
      expect(
        a.toJson(),
        anchor(6, 11, 'brave', 'hello ', ' new world').toJson(),
      );
      final long = '${'x' * 100}Q${'y' * 100}';
      final b = makeAnchor(src, long, 100, 101);
      expect(b.prefix, hasLength(anchorContext));
      expect(b.suffix, hasLength(anchorContext));
    });

    test('throws on bad offsets', () {
      expect(() => makeAnchor(src, 'abc', 2, 1), throwsRangeError);
      expect(() => makeAnchor(src, 'abc', -1, 1), throwsRangeError);
      expect(() => makeAnchor(src, 'abc', 0, 4), throwsRangeError);
    });
  });

  group('resolveAnchor', () {
    test('exact position wins', () {
      const text = 'one two one two';
      expect(resolveAnchor(makeAnchor(src, text, 8, 11), text), (
        start: 8,
        end: 11,
      ));
    });

    test('moved text is found by quote', () {
      final a = makeAnchor(src, 'alpha beta gamma', 6, 10);
      expect(resolveAnchor(a, 'INSERTED alpha beta gamma'), (
        start: 15,
        end: 19,
      ));
    });

    test('duplicate quotes are disambiguated by context', () {
      const text = 'red cat sat. blue cat ran. green cat hid.';
      final start = text.indexOf('cat', 14);
      final a = makeAnchor(src, text, start, start + 3);
      const edited = 'NEW NEW NEW $text';
      final s = edited.indexOf('blue cat') + 5;
      expect(resolveAnchor(a, edited), (start: s, end: s + 3));
    });

    test('tie goes to the hit nearest the original start', () {
      expect(resolveAnchor(anchor(9, 11, 'a', '--', '--'), '--a--------a--'), (
        start: 11,
        end: 12,
      ));
    });

    test('missing quote gives null', () {
      final a = makeAnchor(src, 'hello world', 0, 5);
      expect(resolveAnchor(a, 'goodbye world'), isNull);
    });

    test(
      'ambiguous with zero context score is null; a single occurrence is accepted',
      () {
        final a = anchor(0, 1, 'a', 'QQ', 'QQ');
        expect(resolveAnchor(a, 'xxaxxaxx'), isNull);
        expect(resolveAnchor(a, 'xxxxaxxx'), (start: 4, end: 5));
      },
    );

    test('an empty quote resolves only by exact position', () {
      final a = makeAnchor(src, 'abcd', 2, 2);
      expect(resolveAnchor(a, 'abcd'), (start: 2, end: 2));
      expect(resolveAnchor(a, 'a'), isNull);
      expect(resolveAnchor(a, 'xbcd'), isNull);
    });

    test(
      'never returns a range whose text differs from the quote (property)',
      () {
        var seed = 12345;
        double rnd() {
          seed = (seed * 1664525 + 1013904223) & 0xffffffff;
          return seed / 4294967296;
        }

        int pick(int n) => (rnd() * n).floor();
        const alphabet = 'abc d';
        String word(int n) =>
            List.generate(n, (_) => alphabet[pick(alphabet.length)]).join();
        var nonNull = 0;
        for (var i = 0; i < 3000; i++) {
          final base = word(20 + pick(80));
          final s = pick(base.length);
          final e = s + pick((base.length - s < 8 ? base.length - s : 8) + 1);
          final a = makeAnchor(src, base, s, e);
          var t = base;
          for (var k = 0, n = 1 + pick(4); k < n; k++) {
            final p = pick(t.length + 1);
            final op = pick(4);
            if (op == 0) {
              t = t.substring(0, p) + word(1 + pick(6)) + t.substring(p);
            } else if (op == 1) {
              final cut = p + 1 + pick(6);
              t = t.substring(0, p) + (cut < t.length ? t.substring(cut) : '');
            } else if (op == 2) {
              t = t.substring(0, p) + a.quote + t.substring(p);
            } else {
              t =
                  t.substring(0, p) +
                  word(2) +
                  a.quote +
                  word(2) +
                  t.substring(p);
            }
          }
          final r = resolveAnchor(a, t);
          if (r != null) {
            nonNull++;
            expect(t.substring(r.start, r.end), a.quote);
          }
        }
        expect(nonNull, greaterThan(0));
      },
    );
  });

  group(
    'rendered text, against the desktop (web/src/anchors/mobileParity.test.tsx)',
    () {
      final dir = Directory('test/fixtures/md');
      final fixtures =
          dir
              .listSync()
              .whereType<File>()
              .where((f) => f.path.endsWith('.md'))
              .toList()
            ..sort((a, b) => a.path.compareTo(b.path));
      // the desktop draws a diagram as SVG whose labels are text; the phone shows it as a picture, so around one the
      // offsets differ and an anchor is found again by its quote
      const withDiagram = {'code.md'};

      test(
        'there are fixtures',
        () => expect(fixtures.length, greaterThanOrEqualTo(5)),
      );

      for (final f in fixtures) {
        final name = f.uri.pathSegments.last;
        test('$name matches the desktop', () {
          final desktop = File(
            f.path.replaceAll(RegExp(r'\.md$'), '.txt'),
          ).readAsStringSync();
          final phone = renderedText(parseMarkdown(f.readAsStringSync())).text;
          if (!withDiagram.contains(name)) {
            expect(phone, desktop);
            return;
          }
          // every stretch of a few words anchored on the phone is found with the same quote on the desktop
          final words = RegExp(r'\S+').allMatches(phone).toList();
          for (var i = 0; i + 3 <= words.length; i += 3) {
            final a = makeAnchor(src, phone, words[i].start, words[i + 2].end);
            final r = resolveAnchor(a, desktop);
            expect(r, isNotNull, reason: a.quote);
            expect(desktop.substring(r!.start, r.end), a.quote);
          }
        });
      }

      test('the runs of a node map its raw offsets into the rendered text', () {
        final r = renderedText(parseMarkdown('Hello   **big**\n\nworld'));
        expect(r.text, 'Hello big world');
        final world = r.runs.last;
        expect((world.node as dynamic).text, 'world');
        expect(world.start, 10);
        expect(world.map.first, 10);
      });
    },
  );

  group('locateSelection', () {
    final r = renderedText(
      parseMarkdown('The cache, the cache.\n\nAnd   the **cache** again.'),
    );

    test('a selection is found in the rendered text, whitespace aside', () {
      expect(r.text, 'The cache, the cache. And the cache again.');
      expect(locateSelection(r, 'cache.\nAnd the', 18), (start: 15, end: 29));
    });

    test(
      'of several occurrences, the one nearest the selection\'s position',
      () {
        expect(locateSelection(r, 'cache', 0), (start: 4, end: 9));
        expect(locateSelection(r, 'cache', 16), (start: 15, end: 20));
        expect(locateSelection(r, 'cache', 40), (start: 30, end: 35));
      },
    );

    test('nothing found or only whitespace gives null', () {
      expect(locateSelection(r, 'dog', 0), isNull);
      expect(locateSelection(r, '  \n', 0), isNull);
    });

    test('only an occurrence starting in the selected block is taken', () {
      expect(locateSelection(r, 'cache', 0, within: (start: 22, end: 42)), (
        start: 30,
        end: 35,
      ));
      expect(
        locateSelection(r, 'cache', 0, within: (start: 36, end: 42)),
        isNull,
      );
    });

    test(
      'math, a picture on the phone, is spanned by a selection across it',
      () {
        final m = renderedText(parseMarkdown(r'Take $x^2$ and y.'));
        expect(m.text, r'Take $x^2$ and y.');
        expect(locateSelection(m, 'Take  and y.', 0), (start: 0, end: 17));
        expect(locateSelection(m, 'and', 0), (start: 11, end: 14));
      },
    );
  });
}
