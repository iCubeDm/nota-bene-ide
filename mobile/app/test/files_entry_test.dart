import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/files/files_pane.dart';
import 'package:nb_app/chat/code_screen.dart';
import 'package:nb_app/chat/files.dart';
import 'package:nb_app/files/file_screen.dart';

import 'support/fakes.dart';
import 'support/rig.dart';

Map<String, Object?> tool(String id, String name, Map<String, Object?> input) =>
    agent({
      't': 'tool-call',
      'id': id,
      'name': name,
      'input': input,
      'sub': false,
    });

Map<String, Object?> result(String id) =>
    agent({'t': 'tool-update', 'id': id, 'text': 'ok', 'isError': false});

void main() {
  test('a project file the phone opens, relative to the root', () {
    expect(projectFile('/home/u/notes', 'img/Shot.PNG'), 'img/Shot.PNG');
    expect(projectFile('/home/u/notes', '/home/u/notes/v/a.mov'), 'v/a.mov');
    expect(projectFile('/home/u/notes', 'a.svg'), isNull);
    expect(fileKindOf('a.jpeg'), FileKind.image);
    expect(fileKindOf('a.webm'), FileKind.video);
    expect(fileKindOf('a.md'), FileKind.markdown);

    expect(
      projectFile('/home/u/notes', '/home/u/notes/docs/plan.md'),
      'docs/plan.md',
    );
    expect(projectFile('/home/u/notes', 'docs/plan.md'), 'docs/plan.md');
    expect(projectFile('/home/u/notes', '/home/u/other/plan.md'), isNull);
    expect(projectFile('/home/u/notes', '/home/u/notes/src/a.ts'), isNull);
    expect(projectFile('/home/u/notes', '/home/u/notesX/a.md'), isNull);
    expect(projectFile('/home/u/notes', '../a.md'), isNull);
  });

  testWidgets(
    'a Write line on a project .md opens it; one outside does not offer to',
    (t) async {
      final r = Rig();
      await r.open(
        t,
        events: [
          {
            'kind': 'session',
            'id': 's1',
            'root': '/home/u/notes',
            'title': null,
            'model': null,
          },
          tool('w1', 'Write', {
            'file_path': '/home/u/notes/docs/plan.md',
            'content': '# x',
          }),
          result('w1'),
          tool('w2', 'Write', {
            'file_path': '/tmp/elsewhere.md',
            'content': '# y',
          }),
          result('w2'),
        ],
      );
      r.ch.onHttp = (port, method, path) async =>
          answer(200, '# Plan\n\nBody.');
      expect(find.byTooltip('Open the file'), findsOneWidget);
      await t.tap(find.byTooltip('Open the file'));
      await t.pumpAndSettle();
      expect(find.byType(FileScreen), findsOneWidget);
      expect(r.ch.requests.last, 'GET /file?path=docs%2Fplan.md');
      r.dispose();
    },
  );

  testWidgets(
    'a tool line on any project file opens it as text; a folder does not',
    (t) async {
      final r = Rig();
      await r.open(
        t,
        events: [
          {
            'kind': 'session',
            'id': 's1',
            'root': '/home/u/notes',
            'title': null,
            'model': null,
          },
          tool('r1', 'Read', {'file_path': '/home/u/notes/src/main.ts'}),
          result('r1'),
          tool('g1', 'Grep', {'pattern': 'x', 'path': '/home/u/notes/src'}),
          result('g1'),
        ],
      );
      r.ch.onHttp = (port, method, path) async => answer(200, 'const a = 1;\n');
      expect(find.byTooltip('Open the file'), findsOneWidget);
      await t.tap(find.byTooltip('Open the file'));
      await t.pumpAndSettle();
      expect(find.byType(CodeScreen), findsOneWidget);
      expect(r.ch.requests.last, 'GET /file?path=src%2Fmain.ts');
      r.dispose();
    },
  );

  testWidgets(
    'the Files item shows the Files pane with the session\'s files, newest first, once each',
    (t) async {
      final r = Rig();
      await r.open(
        t,
        events: [
          {
            'kind': 'session',
            'id': 's1',
            'root': '/home/u/notes',
            'title': null,
            'model': null,
          },
          tool('a', 'Read', {'file_path': '/home/u/notes/README.md'}),
          result('a'),
          tool('b', 'Write', {'file_path': '/home/u/notes/docs/plan.md'}),
          result('b'),
          tool('c', 'Edit', {'file_path': '/home/u/notes/README.md'}),
          result('c'),
          tool('d', 'Edit', {'file_path': '/home/u/notes/src/main.ts'}),
          result('d'),
        ],
      );
      expect(sessionFiles(r.tab!), [
        'src/main.ts',
        'README.md',
        'docs/plan.md',
      ]);
      await t.tap(find.text('Files'));
      await t.pumpAndSettle();
      // the host answers no tree here: the session's files are shown all the same
      expect(find.text('This session'), findsOneWidget);
      expect(find.text('main.ts'), findsOneWidget);
      expect(find.text('README.md'), findsOneWidget);
      expect(find.text('plan.md'), findsOneWidget);
      r.dispose();
    },
  );

  testWidgets('no files yet: the list says so', (t) async {
    final r = Rig();
    await r.open(t);
    await t.tap(find.text('Files'));
    await t.pumpAndSettle();
    expect(find.text('This session'), findsNothing);
    expect(find.byType(FolderPage), findsOneWidget);
    r.dispose();
  });

  testWidgets(
    'the strip shows the pending comments, not the sent ones; long-press deletes',
    (t) async {
      final r = Rig();
      await r.open(
        t,
        events: [
          {
            'kind': 'session',
            'id': 's1',
            'root': '/home/u/notes',
            'title': null,
            'model': null,
          },
        ],
      );
      Map<String, Object?> c(
        String id,
        String quote,
        String text,
        String status,
      ) => {
        'id': id,
        'text': text,
        'status': status,
        'createdAt': 1,
        'label': 'clarify',
        'anchor': {
          'source': {'kind': 'file', 'path': 'docs/plan.md'},
          'start': 0,
          'end': quote.length,
          'quote': quote,
          'prefix': '',
          'suffix': '',
        },
      };
      r.event({
        'kind': 'comments',
        'items': [
          c('a', 'first quote', 'one', 'pending'),
          c('b', 'second quote', 'two', 'pending'),
          c('s', 'old', 'gone', 'sent'),
        ],
      });
      await t.pumpAndSettle();
      expect(find.text('2 comments to send'), findsOneWidget);
      expect(find.textContaining('first quote'), findsOneWidget);
      expect(find.textContaining('old'), findsNothing);
      await t.longPress(find.textContaining('second quote'));
      await t.pumpAndSettle();
      await t.tap(find.text('Delete comment'));
      await t.pumpAndSettle();
      final set =
          r.sent.lastWhere((m) => m['type'] == 'comments')['items'] as List;
      expect(set.map((x) => (x as Map)['id']), ['a', 's']);
      r.dispose();
    },
  );
}
