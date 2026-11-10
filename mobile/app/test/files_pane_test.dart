import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/files/files_pane.dart';
import 'package:nb_app/files/remote.dart';
import 'package:nb_app/chat/code_screen.dart';
import 'package:nb_channel/nb_channel.dart';

import 'files_entry_test.dart' show tool, result;
import 'support/fakes.dart';
import 'support/rig.dart';

HttpAnswer json(Object o, [int status = 200]) => answer(status, jsonEncode(o));

void main() {
  test('a long path is cut from the left', () {
    expect(pathTail('a/b'), 'a/b');
    final long = '${'x' * 20}/${'folder/' * 5}end';
    final cut = pathTail(long);
    expect(cut.startsWith('…'), isTrue);
    expect(cut.endsWith('end'), isTrue);
    expect(cut.length, 34);
  });

  test('sortEntries is case-insensitive, folders first', () {
    final s = sortEntries([
      const TreeEntry('b', false),
      const TreeEntry('B', true),
      const TreeEntry('a', true),
    ]);
    expect([for (final e in s) e.name], ['a', 'B', 'b']);
  });
  group('pane', () {
    late Rig r;
    setUp(() => r = Rig());
    tearDown(() => r.dispose());

    final tree = <String, Object>{
      '': [
        {'name': 'zeta.txt', 'dir': false},
        {'name': 'src', 'dir': true},
        {'name': 'README.md', 'dir': false},
        {'name': 'Alpha', 'dir': true},
        {'name': 'beta.dart', 'dir': false},
      ],
      'src': [
        {'name': 'main.dart', 'dir': false},
        {'name': 'lib', 'dir': true},
      ],
      'src/lib': <Object>[],
    };

    /// A window whose host answers /tree, /complete and /file from [tree], [hits] and [files].
    Future<void> open(
      WidgetTester t, {
      Map<String, HttpAnswer> files = const {},
      List<String> hits = const [],
      List<Map<String, Object?>> events = const [],
      Future<HttpAnswer> Function(String method, String path)? other,
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
          ...events,
        ],
      );
      r.ch.onHttp = (port, method, path) async {
        final u = Uri.parse(path);
        switch (u.path) {
          case '/tree':
            final d = u.queryParameters['path'] ?? '';
            return tree.containsKey(d) ? json(tree[d]!) : json([], 404);
          case '/complete':
            return json(hits);
          case '/file':
            return files[u.queryParameters['path']] ?? answer(404, 'no');
        }
        return other != null ? other(method, path) : answer(404, 'no');
      };
      final nav = Navigator.of(t.element(find.byType(Scaffold).first));
      nav.push(
        MaterialPageRoute<void>(
          builder: (_) => Scaffold(body: FilesPane(tab: r.tab!)),
        ),
      );
      await t.pumpAndSettle();
    }

    List<String> titles(WidgetTester t) => [
      for (final w in t.widgetList<ListTile>(find.byType(ListTile)))
        ((w.title as Text).data ?? ''),
    ];

    testWidgets(
      'the room under the header is the pane\'s: every page keeps clear of it, and follows a change',
      (t) async {
        await open(t);
        final inset = ValueNotifier<double>(100);
        Navigator.of(t.element(find.byType(Scaffold).first)).push(
          MaterialPageRoute<void>(
            builder: (_) => Scaffold(
              body: ValueListenableBuilder<double>(
                valueListenable: inset,
                builder: (_, v, _) => FilesPane(tab: r.tab!, topInset: v),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        double top() =>
            t.getTopLeft(find.byKey(const ValueKey('folder-path'))).dy;
        expect(top(), greaterThanOrEqualTo(100));
        await t.tap(find.text('src'));
        await t.pumpAndSettle();
        expect(top(), greaterThanOrEqualTo(100));
        inset.value = 180;
        await t.pump();
        expect(top(), greaterThanOrEqualTo(180));
        inset.dispose();
      },
    );

    testWidgets('This session follows the feed while the pane is open', (
      t,
    ) async {
      await open(
        t,
        events: [
          tool('a', 'Read', {'file_path': '/home/u/notes/README.md'}),
          result('a'),
        ],
      );
      expect(find.text('This session'), findsOneWidget);
      r.event(tool('b', 'Write', {'file_path': '/home/u/notes/docs/plan.md'}));
      await t.pump(const Duration(milliseconds: 500));
      expect(find.text('plan.md'), findsOneWidget);
    });

    testWidgets('the root lists folders first, then files, by name', (t) async {
      await open(t);
      expect(titles(t), ['Alpha', 'src', 'beta.dart', 'README.md', 'zeta.txt']);
      expect(find.byKey(const ValueKey('folder-path')), findsOneWidget);
    });

    testWidgets('a folder opens as a page; back goes up and keeps the root', (
      t,
    ) async {
      await open(t);
      await t.tap(find.text('src'));
      await t.pumpAndSettle();
      expect(titles(t), ['lib', 'main.dart']);
      expect(
        t.widget<Text>(find.byKey(const ValueKey('folder-path'))).data,
        'src',
      );
      await t.tap(find.text('lib'));
      await t.pumpAndSettle();
      expect(
        t.widget<Text>(find.byKey(const ValueKey('folder-path'))).data,
        'src/lib',
      );
      expect(find.text('This folder is empty.'), findsOneWidget);
      await t.tap(find.byTooltip('Up one folder'));
      await t.pumpAndSettle();
      expect(titles(t), ['lib', 'main.dart']);
      await t.tap(find.byTooltip('Up one folder'));
      await t.pumpAndSettle();
      expect(titles(t).first, 'Alpha');
    });

    testWidgets('a text file opens in the code view with line numbers', (
      t,
    ) async {
      await open(
        t,
        files: {'beta.dart': answer(200, 'void main() {}\nint x = 1;\n')},
      );
      await t.tap(find.text('beta.dart'));
      await t.pumpAndSettle();
      expect(find.byType(CodeScreen), findsOneWidget);
      expect(find.textContaining('void main'), findsOneWidget);
      expect(find.text('1'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      // back returns to the same folder
      await t.binding.handlePopRoute();
      await t.pumpAndSettle();
      expect(titles(t).first, 'Alpha');
    });

    testWidgets('a binary file says so, with its size', (t) async {
      await open(
        t,
        files: {
          'zeta.txt': answer(200, String.fromCharCodes([65, 0, 66])),
        },
      );
      await t.tap(find.text('zeta.txt'));
      await t.pumpAndSettle();
      expect(find.byType(CodeScreen), findsNothing);
      expect(find.textContaining('binary file, 3 B'), findsOneWidget);
    });

    testWidgets('an empty file is an empty text, not an error', (t) async {
      await open(
        t,
        files: {
          // the Range request for a 0-byte file is unsatisfiable
          'zeta.txt': answer(416, '', headers: {'content-range': 'bytes */0'}),
        },
      );
      await t.tap(find.text('zeta.txt'));
      await t.pumpAndSettle();
      expect(find.byType(CodeScreen), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
    });

    testWidgets('a file over the cap says so with the total size', (t) async {
      await open(
        t,
        files: {
          'zeta.txt': answer(
            206,
            'x' * 10,
            headers: {'content-range': 'bytes 0-2097152/5242880'},
          ),
        },
      );
      await t.tap(find.text('zeta.txt'));
      await t.pumpAndSettle();
      expect(find.textContaining('5.0 MB'), findsOneWidget);
    });

    testWidgets('a failed folder says so and Retry asks again', (t) async {
      await open(t);
      var up = false;
      r.ch.onHttp = (port, method, path) async {
        if (!up) return json([], 403);
        return json(tree['']!);
      };
      await t.tap(find.text('src'));
      await t.pumpAndSettle();
      expect(find.text('This file is outside the project.'), findsOneWidget);
      up = true;
      await t.tap(find.text('Retry'));
      await t.pumpAndSettle();
      expect(find.text('This file is outside the project.'), findsNothing);
    });

    testWidgets('a missing file and an offline host each say what happened', (
      t,
    ) async {
      await open(t);
      await t.tap(find.text('beta.dart'));
      await t.pumpAndSettle();
      expect(find.text('This file is not there (any more).'), findsOneWidget);
      await t.tap(find.text('Retry'));
      await t.pumpAndSettle();
      expect(find.text('This file is not there (any more).'), findsOneWidget);
    });

    testWidgets(
      'typing searches after a pause; a hit opens, a folder hit drills',
      (t) async {
        await open(
          t,
          hits: ['src/', 'src/main.dart'],
          files: {'src/main.dart': answer(200, 'a')},
        );
        await t.enterText(find.byType(TextField), 'ma');
        await t.pump(const Duration(milliseconds: 100));
        expect(r.ch.requests.where((q) => q.contains('/complete')), isEmpty);
        await t.pump(const Duration(milliseconds: 200));
        await t.pumpAndSettle();
        expect(r.ch.requests.where((q) => q.contains('/complete')).length, 1);
        expect(r.ch.requests.last, contains('q=ma'));
        expect(titles(t), ['src', 'main.dart']);
        await t.tap(find.text('src').first);
        await t.pumpAndSettle();
        expect(titles(t), ['lib', 'main.dart']);
        await t.tap(find.byTooltip('Up one folder'));
        await t.pumpAndSettle();
        await t.tap(find.text('main.dart'));
        await t.pumpAndSettle();
        expect(find.byType(CodeScreen), findsOneWidget);
      },
    );

    testWidgets('the session\'s files are on top, five and "Show all"', (
      t,
    ) async {
      final calls = [
        for (var i = 0; i < 7; i++)
          agent({
            't': 'tool-call',
            'id': 't$i',
            'name': 'Read',
            'input': {'file_path': '/home/u/notes/docs/f$i.ts'},
            'sub': false,
          }),
      ];
      await open(
        t,
        events: [
          for (final c in calls) {...c, 'kind': 'agent'},
        ],
      );
      expect(find.text('This session'), findsOneWidget);
      expect(find.text('Show all (7)'), findsOneWidget);
      await t.tap(find.text('Show all (7)'));
      await t.pumpAndSettle();
      expect(find.text('Show all (7)'), findsNothing);
      expect(find.text('f6.ts'), findsOneWidget);
    });
  });
}
