import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/feed.dart';
import 'package:nb_app/comments/comments.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/rig.dart';

Comment c(
  String id,
  String quote,
  String text, {
  QuickLabelId? label,
  AnchorSource source = const AnchorSourceFile(path: 'docs/plan.md'),
  CommentStatus status = CommentStatus.pending,
}) => Comment(
  id: id,
  anchor: TextAnchor(
    source: source,
    start: 0,
    end: quote.length,
    quote: quote,
    prefix: '',
    suffix: '',
  ),
  text: text,
  label: label,
  status: status,
  createdAt: 1,
);

Map<String, Object?> json(Comment x) => x.toJson();

/// the desktop's batch for the same comments (web/src/comments/mobileBatch.test.ts)
final fixture =
    jsonDecode(File('test/fixtures/batch/media.json').readAsStringSync())
        as Map<String, Object?>;

void main() {
  group('composeBatch (compose.test.ts, text anchors)', () {
    test('general text first, then the header and numbered items', () {
      final out = composeBatch('Please fix', [
        c('a', 'foo', ' bar '),
        c(
          'b',
          'baz',
          'qux',
          source: const AnchorSourceFile(path: 'a.md', ref: 'main'),
        ),
      ], 'en');
      expect(
        out,
        'Please fix\n\nComments on fragments:\n\n1. [docs/plan.md]\n> foo\n→ bar\n\n2. [a.md @ main]\n> baz\n→ qux',
      );
    });

    test('no general text: the header first, in the batch language', () {
      expect(
        composeBatch('', [c('a', 'x', 'y')], 'ru'),
        startsWith('Комментарии к фрагментам:\n\n1.'),
      );
    });

    test('multi-line quotes are each prefixed', () {
      expect(
        composeBatch('', [c('a', 'l1\nl2', 'y')], 'en'),
        contains('> l1\n> l2\n→ y'),
      );
    });

    test('a quick label adds its emoji, text and English instruction', () {
      final out = composeBatch('', [
        c('a', 'q', '', label: QuickLabelId.verify),
      ], 'en');
      expect(
        out,
        contains('→ 🔍 Verify this\n   This seems like an assumption.'),
      );
      final ru = composeBatch('', [
        c('a', 'q', 'почему?', label: QuickLabelId.clarify),
      ], 'ru');
      expect(ru, contains('→ ❓ Поясни почему?'));
    });

    test('no comments: the general text unchanged', () {
      expect(composeBatch('just text', [], 'en'), 'just text');
    });
  });

  group('composeSend, against the desktop (mobileBatch.test.ts)', () {
    final all = {
      for (final e in (fixture['comments'] as Map).entries)
        e.key as String: Comment.fromJson(
          (e.value as Map).cast<String, Object?>(),
        ),
    };
    final stale = {for (final s in fixture['stale'] as List) s as String};
    for (final k in fixture['cases'] as List) {
      final name = (k as Map)['name'] as String;
      for (final e in (k['out'] as Map).entries) {
        test('$name in ${e.key}', () {
          final out = composeSend(
            k['general'] as String,
            [for (final i in k['items'] as List) all[i]!],
            Feed(),
            e.key as String,
            staleOf: (c) => stale.contains(c.id),
          );
          final want = e.value as Map;
          expect(out.text, want['text']);
          expect([
            for (final im in out.images) {'id': im.id, 'label': im.label},
          ], want['images']);
        });
      }
    }
  });

  group('composeSend with the composer\'s own images', () {
    ImageRef own(String id) =>
        ImageRef(id: id, mediaType: ImageType.image_jpeg, label: 'x');
    final withPaste = Comment(
      id: 'p',
      anchor: TextAnchor(
        source: const AnchorSourceFile(path: 'a.md'),
        start: 0,
        end: 1,
        quote: 'q',
        prefix: '',
        suffix: '',
      ),
      text: 'see',
      images: ['c' * 64],
      status: CommentStatus.pending,
      createdAt: 1,
    );

    test('come first, labelled imgLabel by position, the comments after', () {
      final out = composeSend(
        '',
        [withPaste],
        Feed(),
        'ru',
        own: [own('a' * 64), own('b' * 64)],
      );
      expect(out.images.map((i) => i.id), ['a' * 64, 'b' * 64, 'c' * 64]);
      expect(out.images.map((i) => i.mediaType).take(2), [
        ImageType.image_jpeg,
        ImageType.image_jpeg,
      ]);
      expect(out.images.map((i) => i.label), [
        batchTemplate('imgLabel', 'ru', [1]),
        batchTemplate('imgLabel', 'ru', [2]),
        batchTemplate('imgLabelC', 'ru', [3, 1]),
      ]);
      expect(out.text, contains(batchTemplate('imgRef', 'ru', ['3'])));
    });

    test('alone, without comments or text, are the whole send', () {
      final out = composeSend('', [], Feed(), 'en', own: [own('a' * 64)]);
      expect((out.text, out.images.single.label), ('', '[image 1]'));
    });
  });

  group('composeSend names a chat fragment as the desktop does', () {
    final feed = Feed()
      ..items = [
        UserItem('u1', 'hello'),
        AssistantItem('a1', 'the answer', final_: true),
        AssistantItem('stream:0', 'still coming', final_: false),
      ];
    String where(String id, String lang) {
      final out = composeSend(
        '',
        [c('x', 'q', 'w', source: AnchorSourceMessage(id: id))],
        feed,
        lang,
      ).text;
      return RegExp(r'1\. \[(.*)\]').firstMatch(out)![1]!;
    }

    for (final lang in ['en', 'ru', 'zh', 'es', 'pt', 'de']) {
      test(lang, () {
        expect(where('u1', lang), webString('srcMine', lang));
        expect(where('a1', lang), webString('replyPlain', lang));
        expect(where('gone', lang), batchString('srcChat', lang));
        expect(where('stream:0', lang), batchString('srcChat', lang));
      });
    }

    test('the words are the desktop\'s', () {
      expect(where('u1', 'en'), 'my message');
      expect(where('a1', 'en'), 'reply');
      expect(where('gone', 'en'), 'chat');
      expect(where('u1', 'ru'), isNot('my message'));
    });
  });

  group('Comments', () {
    late List<ClientMessage> out;
    late Comments cs;
    setUp(() {
      out = [];
      cs = Comments((m) {
        out.add(m);
        return true;
      }, () => 's1');
    });

    test('the server set replaces the list; pending and per file', () {
      cs.apply([
        c('a', 'x', '1'),
        c('b', 'y', '2', status: CommentStatus.sent),
        c('d', 'z', '3', source: const AnchorSourceFile(path: 'other.md')),
      ]);
      expect(cs.pending.map((x) => x.id), ['a', 'd']);
      expect(cs.forFile('docs/plan.md').map((x) => x.id), ['a', 'b']);
    });

    test(
      'add sends the whole set with the new one, keeping the desktop\'s',
      () {
        cs.apply([c('a', 'x', 'desk')]);
        final n = cs.add(
          c('tmp', 'q', '').anchor as TextAnchor,
          'mine',
          QuickLabelId.fire,
        );
        final m = out.single as ClientMessageComments;
        expect(m.sessionId, 's1');
        expect(m.items.map((x) => x.id), ['a', n.id]);
        expect(m.items.last.label, QuickLabelId.fire);
        expect(m.items.last.status, CommentStatus.pending);
      },
    );

    test('an older set arriving before the echo keeps the new comment', () {
      cs.apply([c('a', 'x', 'desk')]);
      final n = cs.add(c('tmp', 'q', '').anchor as TextAnchor, 'mine', null);
      cs.apply([c('a', 'x', 'desk')]); // broadcast from before ours
      expect(cs.all.map((x) => x.id), ['a', n.id]);
      cs.apply([c('a', 'x', 'desk'), cs.all.last]); // our echo
      cs.apply([
        c('a', 'x', 'desk'),
      ]); // the desktop removed ours after that: gone
      expect(cs.all.map((x) => x.id), ['a']);
    });

    test('edit and remove send the changed set', () {
      cs.apply([c('a', 'x', '1'), c('b', 'y', '2')]);
      cs.edit('a', 'new', QuickLabelId.example);
      expect((out.last as ClientMessageComments).items.first.text, 'new');
      cs.remove('b');
      expect((out.last as ClientMessageComments).items.map((x) => x.id), ['a']);
    });

    test('remove keeps a comment of ours the server has not echoed yet', () {
      cs.apply([c('a', 'x', '1'), c('b', 'y', '2')]);
      final n = cs.add(c('tmp', 'q', '').anchor as TextAnchor, 'mine', null);
      cs.remove('b');
      expect((out.last as ClientMessageComments).items.map((x) => x.id), [
        'a',
        n.id,
      ]);
    });

    test(
      'comments with images are sent; page and 3D model comments stay for the desktop',
      () {
        final x = c('a', 'x', 'see');
        final media = (fixture['comments'] as Map)['video'] as Map;
        Comment page() => Comment.fromJson({
          'id': 'page',
          'anchor': {
            'kind': 'page',
            'source': {'kind': 'file', 'path': 'a.html'},
            'selector': 'body>div',
            'trail': ['div'],
          },
          'text': 't',
          'status': 'pending',
          'createdAt': 1,
        });
        Comment model() {
          final j = Map<String, Object?>.from(media.cast<String, Object?>());
          final a = Map<String, Object?>.from(j['anchor'] as Map)
            ..remove('time')
            ..['camera'] = {
              'position': [0, 0, 1],
              'target': [0, 0, 0],
              'fov': 50,
            };
          return Comment.fromJson({...j, 'id': 'model', 'anchor': a});
        }

        cs.apply([
          Comment(
            id: 'img',
            anchor: x.anchor,
            text: 'look',
            status: CommentStatus.pending,
            createdAt: 1,
            images: const ['i1'],
          ),
          Comment.fromJson(media.cast<String, Object?>()),
          page(),
          model(),
          x,
        ]);
        expect(cs.sendable.map((x) => x.id), [
          'img',
          '22222222-2222-4222-8222-222222222222',
          'a',
        ]);
      },
    );

    test(
      'comments being sent are not offered again until the server answers',
      () {
        cs.apply([c('a', 'x', '1'), c('b', 'y', '2')]);
        cs.sending({'a'});
        expect(cs.sendable.map((x) => x.id), ['b']);
        cs.unsending({'a'});
        expect(cs.sendable.map((x) => x.id), ['a', 'b']);
        cs.sending({'a'});
        cs.apply([c('a', 'x', '1'), c('b', 'y', '2')]);
        expect(cs.sendable.map((x) => x.id), ['a', 'b']);
      },
    );
  });

  testWidgets('send takes the pending comments: the batch text and their ids', (
    t,
  ) async {
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
    r.event({
      'kind': 'comments',
      'items': [
        json(c('a', 'the cache', 'why twice?', label: QuickLabelId.clarify)),
        json(c('b', 'old', 'done', status: CommentStatus.sent)),
      ],
    });
    await t.pumpAndSettle();
    expect(r.tab!.comments.pending, hasLength(1));
    await t.enter('Look at this');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    final send = r.sent.lastWhere((m) => m['type'] == 'send');
    expect(send['commentIds'], ['a']);
    expect(
      send['text'],
      'Look at this\n\nComments on fragments:\n\n1. [docs/plan.md]\n> the cache\n→ ❓ Clarify this why twice?',
    );
    r.dispose();
  });

  testWidgets(
    'a media comment leaves with its frame, labelled as the desktop does',
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
      final media = (fixture['comments'] as Map)['image'] as Map;
      r.event({
        'kind': 'comments',
        'items': [media],
      });
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Send'));
      await t.pumpAndSettle();
      final send = r.sent.lastWhere((m) => m['type'] == 'send');
      final want =
          ((fixture['cases'] as List).firstWhere(
                    (k) => (k as Map)['name'] == 'image',
                  )
                  as Map)['out']['en']
              as Map;
      expect(send['text'], want['text']);
      expect(send['commentIds'], [media['id']]);
      expect(send['images'], [
        for (final im in want['images'] as List)
          {...(im as Map), 'mediaType': 'image/png'},
      ]);
      r.dispose();
    },
  );

  testWidgets('comments alone can be sent, with an empty field', (t) async {
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
    r.event({
      'kind': 'comments',
      'items': [json(c('a', 'x', 'only this'))],
    });
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    final send = r.sent.lastWhere((m) => m['type'] == 'send');
    expect(send['text'], startsWith('Comments on fragments:'));
    r.dispose();
  });

  Future<Rig> withComments(WidgetTester t, List<Comment> items) async {
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
    r.event({
      'kind': 'comments',
      'items': [for (final x in items) json(x)],
    });
    await t.pumpAndSettle();
    return r;
  }

  List<Map<String, Object?>> sends(Rig r) => [
    for (final m in r.sent)
      if (m['type'] == 'send') m,
  ];

  testWidgets(
    'a second tap before the server answers does not send them again',
    (t) async {
      final r = await withComments(t, [c('a', 'x', 'only this')]);
      await t.tap(find.byTooltip('Send'));
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Send'));
      await t.pumpAndSettle();
      expect(sends(r), hasLength(1));
      expect(find.text('1 comment to send'), findsNothing);
      r.dispose();
    },
  );

  testWidgets('a refused send offers its comments again', (t) async {
    final r = await withComments(t, [c('a', 'x', 'only this')]);
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    r.event({
      'kind': 'send-refused',
      'id': sends(r).single['id'],
      'reason': 'busy',
    });
    await t.pumpAndSettle();
    expect(r.tab!.comments.sendable.map((x) => x.id), ['a']);
    r.dispose();
  });

  testWidgets('the comments are taken as they are when the send leaves', (
    t,
  ) async {
    final r = await withComments(t, [c('a', 'x', 'only this')]);
    r.event({'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1});
    await t.pumpAndSettle();
    await t.enter('Next');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    // the desktop sent them while the dialog was up
    r.event({
      'kind': 'comments',
      'items': [json(c('a', 'x', 'only this', status: CommentStatus.sent))],
    });
    await t.pumpAndSettle();
    await t.tapText('Send after this turn');
    final send = sends(r).single;
    expect(send['text'], 'Next');
    expect(send.containsKey('commentIds'), isFalse);
    r.dispose();
  });
}
