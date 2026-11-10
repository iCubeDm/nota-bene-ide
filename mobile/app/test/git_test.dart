import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/files/diff_screen.dart';
import 'package:nb_app/files/files_pane.dart';
import 'package:nb_app/files/git.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_app/ui/folder_tabs.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/fakes.dart';
import 'support/rig.dart';
import 'support/sheet.dart';

/// The screen position of [word] in the rendered paragraphs inside [within].
Offset wordAt(
  WidgetTester t,
  String word, {
  required Finder within,
  int nth = 0,
}) {
  var seen = 0;
  for (final p in t.renderObjectList<RenderParagraph>(
    find.descendant(of: within, matching: find.byType(RichText)),
  )) {
    final text = p.text.toPlainText();
    final i = text.indexOf(word);
    if (i == -1 || seen++ < nth) continue;
    final box = p
        .getBoxesForSelection(
          TextSelection(baseOffset: i, extentOffset: i + word.length),
        )
        .first;
    return p.localToGlobal(box.toRect().center);
  }
  throw StateError('no $word');
}

const patch = '''diff --git a/lib/a.dart b/lib/a.dart
index 111..222 100644
--- a/lib/a.dart
+++ b/lib/a.dart
@@ -1,3 +1,4 @@
 keep one
-old line
+new line
+added line
 keep two
@@ -20,2 +21,2 @@
 tail
-gone
+here
''';

HttpAnswer json(Object? o, [int status = 200]) => answer(status, jsonEncode(o));

void main() {
  group('parsePatch', () {
    test('rows with both line numbers, hunks, counts', () {
      final p = parsePatch(patch);
      expect(p.hunks, hasLength(2));
      expect((p.add, p.del), (3, 2));
      final rows = p.hunks.first.rows;
      expect(
        [for (final r in rows) '${r.t}${r.o ?? ''}:${r.n ?? ''}:${r.s}'],
        [
          ' 1:1:keep one',
          '-2::old line',
          '+:2:new line',
          '+:3:added line',
          ' 3:4:keep two',
        ],
      );
      expect(p.hunks.last.rows.first.o, 20);
      expect(p.hunks.last.rows.first.n, 21);
    });

    test('a binary patch and an empty one', () {
      expect(parsePatch('Binary files a/x and b/x differ\n').binary, isTrue);
      expect(parsePatch('').hunks, isEmpty);
    });
  });

  group('in a window', () {
    late Rig r;
    setUp(() => r = Rig());
    tearDown(() => r.dispose());

    final changes = {
      'repo': true,
      'branch': 'feature',
      'live': true,
      'base': 'main',
      'uncommitted': false,
      'files': [
        {
          'path': 'lib/a.dart',
          'status': 'M',
          'add': 3,
          'del': 2,
          'binary': false,
        },
        {
          'path': 'logo.png',
          'status': 'A',
          'add': null,
          'del': null,
          'binary': true,
        },
        {'path': 'new.txt', 'status': 'A', 'add': 0, 'del': 0, 'binary': false},
      ],
      'truncated': false,
    };
    final log = {
      'repo': true,
      'commits': [
        {
          'sha': 'a' * 40,
          'parents': <String>[],
          'author': 'Dev',
          'at': 1700000000,
          'subject': 'Add the thing',
          'refs': ['HEAD -> feature'],
        },
      ],
      'tip': 'a' * 40,
      'more': false,
    };
    final commit = {
      'sha': 'a' * 40,
      'author': 'Dev',
      'at': 1700000000,
      'message': 'Add the thing\n\nWith a body.',
      'files': [
        {
          'path': 'lib/a.dart',
          'status': 'M',
          'add': 3,
          'del': 2,
          'binary': false,
        },
      ],
      'truncated': false,
    };

    Future<void> open(
      WidgetTester t, {
      Object? gitStatus = const {
        'branch': 'feature',
        'detached': false,
        'dirty': true,
      },
      Map<String, String> patches = const {},
      double inset = 0,
    }) async {
      await r.open(
        t,
        events: [
          {
            'kind': 'session',
            'id': 's',
            'root': '/home/u/notes',
            'title': 'x',
            'model': 'm',
          },
        ],
      );
      r.ch.onHttp = (port, method, path) async {
        final u = Uri.parse(path);
        switch (u.path) {
          case '/git-status':
            return json(gitStatus);
          case '/vcs-diff':
            return json(changes);
          case '/vcs-file':
            return json({
              'patch': patches[u.queryParameters['path']] ?? patch,
              'truncated': false,
            });
          case '/vcs-log':
            return json(log);
          case '/vcs-commit':
            return json(commit);
          case '/vcs-commit-file':
            return json({'patch': patch, 'truncated': false});
          case '/tree':
            return json([
              {'name': 'lib', 'dir': true},
            ]);
        }
        return answer(404, 'no');
      };
      final nav = Navigator.of(t.element(find.byType(Scaffold).first));
      nav.push(
        MaterialPageRoute<void>(
          builder: (_) => Scaffold(
            body: FilesPane(tab: r.tab!, topInset: inset),
          ),
        ),
      );
      await t.pumpAndSettle();
    }

    testWidgets('outside a repository the tabs are hidden', (t) async {
      await open(t, gitStatus: null);
      expect(find.text('Changes'), findsNothing);
      expect(find.text('Log'), findsNothing);
      expect(find.text('lib'), findsOneWidget);
    });

    testWidgets('in a repository: Files, Changes and Log tabs', (t) async {
      await open(t);
      for (final label in ['Files', 'Changes', 'Log']) {
        expect(find.text(label), findsOneWidget);
      }
      await t.tap(find.text('Changes'));
      await t.pumpAndSettle();
      expect(find.text('feature against main'), findsOneWidget);
      expect(find.text('a.dart'), findsOneWidget);
      expect(find.text('+3 '), findsNothing);
      await t.tap(find.text('Files'));
      await t.pumpAndSettle();
      expect(find.text('lib'), findsOneWidget);
    });

    testWidgets('a changed file opens its diff: numbers, tints, no wrap', (
      t,
    ) async {
      await open(t);
      await t.tap(find.text('Changes'));
      await t.pumpAndSettle();
      await t.tap(find.text('a.dart'));
      await t.pumpAndSettle();
      expect(find.byType(DiffScreen), findsOneWidget);
      expect(r.ch.requests.last, 'GET /vcs-file?path=lib%2Fa.dart');
      expect(find.text('old line'), findsOneWidget);
      expect(find.text('new line'), findsOneWidget);
      expect(find.text('@@ -1,3 +1,4 @@'), findsOneWidget);
      final c = Theme.of(
        t.element(find.byType(DiffScreen)),
      ).extension<NbColors>()!;
      Color? tint(String text) => t
          .widgetList<Container>(
            find.ancestor(
              of: find.text(text),
              matching: find.byType(Container),
            ),
          )
          .map((w) => w.color)
          .whereType<Color>()
          .firstOrNull;
      expect(tint('new line'), c.synAddBg);
      expect(tint('old line'), c.synDelBg);
      expect(tint('keep one'), isNull);
      // the new line number of the added row
      expect(find.text('2'), findsWidgets);
      await t.tap(find.byTooltip('Close'));
      await t.pumpAndSettle();
      expect(find.byType(DiffScreen), findsNothing);
    });

    testWidgets('a binary file and an empty one say so', (t) async {
      await open(t, patches: {'new.txt': ''});
      await t.tap(find.text('Changes'));
      await t.pumpAndSettle();
      await t.tap(find.text('logo.png'));
      await t.pumpAndSettle();
      expect(find.text('Binary file, not shown'), findsOneWidget);
      await t.tap(find.byTooltip('Close'));
      await t.pumpAndSettle();
      await t.tap(find.text('new.txt'));
      await t.pumpAndSettle();
      expect(find.text('Empty file'), findsOneWidget);
    });

    testWidgets('a failed patch says so and Retry asks again', (t) async {
      await open(t);
      await t.tap(find.text('Changes'));
      await t.pumpAndSettle();
      final old = r.ch.onHttp!;
      var up = false;
      r.ch.onHttp = (port, method, path) async {
        if (path.startsWith('/vcs-file') && !up) return json(null, 403);
        return old(port, method, path);
      };
      await t.tap(find.text('a.dart'));
      await t.pumpAndSettle();
      expect(find.text('This file is outside the project.'), findsOneWidget);
      up = true;
      await t.tap(find.text('Retry'));
      await t.pumpAndSettle();
      expect(find.text('new line'), findsOneWidget);
    });

    const repeated = '''@@ -1,3 +1,3 @@
 same
-old
+new
 same
''';

    Future<void> openDiffOf(WidgetTester t, {String file = 'a.dart'}) async {
      await t.tap(find.text('Changes'));
      await t.pumpAndSettle();
      await t.tap(find.text(file));
      await t.pumpAndSettle();
    }

    testWidgets('a comment on a repeated line anchors where it was selected', (
      t,
    ) async {
      await open(t, patches: {'lib/a.dart': repeated});
      await openDiffOf(t);
      await t.longPressAt(
        wordAt(t, 'same', within: find.byType(DiffScreen), nth: 1),
      );
      await t.pumpAndSettle();
      await t.tap(
        find.descendant(
          of: find.byType(DiffScreen),
          matching: find.byTooltip('Comment'),
        ),
      );
      await t.pumpAndSettle();
      await sendNote(t);
      await t.pumpAndSettle();
      final a = r.tab!.comments.all.single.anchor as TextAnchor;
      // `same old new same`: the second one
      expect(a.start, 13);
    });

    Map<String, Object?> note(String id, int start, {String? ref}) => {
      'id': id,
      'text': 'n $id',
      'status': 'pending',
      'createdAt': 1,
      'anchor': {
        'source': {'kind': 'file', 'path': 'lib/a.dart', 'ref': ?ref},
        'start': start,
        'end': start + 3,
        'quote': 'new',
        'prefix': 'same old ',
        'suffix': ' same',
      },
    };

    List<String> painted(WidgetTester t) {
      final out = <String>[];
      for (final p in t.renderObjectList<RenderParagraph>(
        find.descendant(
          of: find.byType(DiffScreen),
          matching: find.byType(RichText),
        ),
      )) {
        p.text.visitChildren((s) {
          if (s is TextSpan &&
              s.style?.backgroundColor != null &&
              s.text != null) {
            out.add(s.text!);
          }
          return true;
        });
      }
      return out;
    }

    testWidgets('the comments of the diff are painted; a commit\'s are not on '
        'the working diff', (t) async {
      await open(t, patches: {'lib/a.dart': repeated});
      r.event({
        'kind': 'comments',
        'items': [note('a', 9), note('b', 9, ref: 'main')],
      });
      await t.pumpAndSettle();
      await openDiffOf(t);
      expect(painted(t), ['new']);
    });

    testWidgets('a big diff builds only the rows near the screen', (t) async {
      final big = StringBuffer('@@ -1,2900 +1,2900 @@\n');
      for (var i = 0; i < 2900; i++) {
        big.writeln(' line $i');
      }
      await open(t, patches: {'lib/a.dart': big.toString()});
      await openDiffOf(t);
      expect(find.byType(DiffScreen), findsOneWidget);
      expect(find.textContaining('line ').evaluate().length, lessThan(100));
    });

    testWidgets('pages of the pane start below the room the host keeps', (
      t,
    ) async {
      await open(t, inset: 100);
      expect(
        t.getTopLeft(find.byType(FolderTabs)).dy,
        greaterThanOrEqualTo(100),
      );
      await t.tap(find.text('Log'));
      await t.pumpAndSettle();
      await t.tap(find.text('Add the thing'));
      await t.pumpAndSettle();
      expect(t.getTopLeft(find.byType(AppBar)).dy, greaterThanOrEqualTo(100));
    });

    testWidgets('a diff over 3000 rows waits for Show', (t) async {
      final big = StringBuffer('@@ -1,3100 +1,3100 @@\n');
      for (var i = 0; i < 3100; i++) {
        big.writeln(' line $i');
      }
      await open(t, patches: {'lib/a.dart': big.toString()});
      await t.tap(find.text('Changes'));
      await t.pumpAndSettle();
      await t.tap(find.text('a.dart'));
      await t.pumpAndSettle();
      expect(find.text('Large diff: 3100 lines.'), findsOneWidget);
      expect(find.text('line 5'), findsNothing);
    });

    testWidgets(
      'the log lists commits; a commit opens its files and a file its diff',
      (t) async {
        await open(t);
        await t.tap(find.text('Log'));
        await t.pumpAndSettle();
        expect(find.text('Add the thing'), findsOneWidget);
        await t.tap(find.text('Add the thing'));
        await t.pumpAndSettle();
        expect(find.textContaining('With a body.'), findsOneWidget);
        await t.tap(find.text('a.dart'));
        await t.pumpAndSettle();
        expect(find.byType(DiffScreen), findsOneWidget);
        expect(
          r.ch.requests.last,
          contains('/vcs-commit-file?sha=${'a' * 40}'),
        );
        // back from the diff and from the commit returns to the log
        await t.tap(find.byTooltip('Close'));
        await t.pumpAndSettle();
        await t.tap(find.byType(BackButton));
        await t.pumpAndSettle();
        expect(find.text('Add the thing'), findsOneWidget);
      },
    );

    testWidgets(
      'a comment on a selection in a diff is anchored as the desktop does',
      (t) async {
        await open(t);
        await t.tap(find.text('Changes'));
        await t.pumpAndSettle();
        await t.tap(find.text('a.dart'));
        await t.pumpAndSettle();
        await t.longPressAt(
          wordAt(t, 'added', within: find.byType(DiffScreen)),
        );
        await t.pumpAndSettle();
        await t.tap(
          find.descendant(
            of: find.byType(DiffScreen),
            matching: find.byTooltip('Comment'),
          ),
        );
        await t.pumpAndSettle();
        await sendNote(t);
        await t.pumpAndSettle();
        final a = r.tab!.comments.all.single.anchor as TextAnchor;
        final s = a.source as AnchorSourceFile;
        expect((s.path, s.ref), ('lib/a.dart', null));
        // the text of the code rows, each row's text then a space
        const text =
            'keep one old line new line added line keep two tail gone here';
        expect(a.quote, 'added');
        expect(a.start, text.indexOf('added'));
        expect(a.prefix, text.substring(0, a.start.toInt()));
      },
    );

    testWidgets('a comment on a commit\'s diff carries the short hash', (
      t,
    ) async {
      await open(t);
      await t.tap(find.text('Log'));
      await t.pumpAndSettle();
      await t.tap(find.text('Add the thing'));
      await t.pumpAndSettle();
      await t.tap(find.text('a.dart'));
      await t.pumpAndSettle();
      await t.longPressAt(wordAt(t, 'gone', within: find.byType(DiffScreen)));
      await t.pumpAndSettle();
      await t.tap(
        find.descendant(
          of: find.byType(DiffScreen),
          matching: find.byTooltip('Comment'),
        ),
      );
      await t.pumpAndSettle();
      await sendNote(t);
      await t.pumpAndSettle();
      final s =
          (r.tab!.comments.all.single.anchor as TextAnchor).source
              as AnchorSourceFile;
      expect(s.ref, 'a' * 7);
    });
  });
}
