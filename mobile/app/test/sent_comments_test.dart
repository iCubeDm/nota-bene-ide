import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/chat_anchor.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'comments_test.dart' show c, clip, json;
import 'support/rig.dart';

Map<String, Object?> sent(
  String id,
  String quote,
  String text, {
  String? in_ = 'u1',
  QuickLabelId? label,
  List<VoiceClip>? voice,
}) {
  final x = c(
    id,
    quote,
    text,
    label: label,
    status: CommentStatus.sent,
    voice: voice,
  );
  return {...json(x), 'sentIn': ?in_};
}

const batch =
    'Look at this\n\nComments on fragments:\n\n1. [docs/plan.md]\n> the cache\n→ why twice?';

void main() {
  test('the web counts: forms by the language', () {
    expect(webCount('nComments', 'en', 1), '1 comment');
    expect(webCount('nComments', 'en', 3), '3 comments');
    expect(webCount('nComments', 'ru', 1), '1 комментарий');
    expect(webCount('nComments', 'ru', 2), '2 комментария');
    expect(webCount('nComments', 'ru', 5), '5 комментариев');
    expect(webCount('nComments', 'ru', 21), '21 комментарий');
    expect(webCount('nComments', 'ru', 12), '12 комментариев');
    expect(webCount('nComments', 'zh', 4), '4 条评论');
  });

  test('batchRaw is what follows the heading', () {
    expect(batchRaw(batch), '1. [docs/plan.md]\n> the cache\n→ why twice?');
    expect(batchRaw('plain'), isNull);
  });

  group('in the chat', () {
    late Rig r;
    setUp(() => r = Rig());
    tearDown(() => r.dispose());

    Future<void> open(
      WidgetTester t,
      List<Map<String, Object?>> comments, {
      String text = 'Look at this',
    }) async {
      await r.open(
        t,
        events: [
          {'kind': 'user', 'id': 'u1', 'text': text, 'ts': 1, 'historic': true},
        ],
      );
      // the set comes on its own after the replay, as the server sends it on connect
      r.event({'kind': 'comments', 'items': comments});
      await t.pumpAndSettle();
    }

    testWidgets(
      'a replayed message shows its sent comments folded, and unfolds them',
      (t) async {
        await open(t, [
          sent('a', 'the cache', 'why twice?', label: QuickLabelId.clarify),
          sent('b', 'other', 'elsewhere', in_: 'u2'),
          {...json(c('p', 'pending one', 'later')), 'sentIn': null}
            ..remove('sentIn'),
        ]);
        expect(find.text('1 comment'), findsOneWidget);
        expect(find.text('the cache'), findsNothing);
        await t.tap(find.text('1 comment'));
        await t.pumpAndSettle();
        expect(find.text('the cache'), findsOneWidget);
        expect(find.textContaining('why twice?'), findsOneWidget);
        expect(find.textContaining('Clarify'), findsOneWidget);
        expect(find.text('other'), findsNothing);
        expect(find.text('pending one'), findsNothing);
        await t.tap(find.text('1 comment'));
        await t.pumpAndSettle();
        expect(find.text('the cache'), findsNothing);
      },
    );

    testWidgets('the count follows the language', (t) async {
      t.platformDispatcher.localesTestValue = const [Locale('ru')];
      addTearDown(t.platformDispatcher.clearLocalesTestValue);
      await open(t, [sent('a', 'x', 'one'), sent('b', 'y', 'two')]);
      expect(find.text('2 комментария'), findsOneWidget);
    });

    testWidgets('comments that arrive after the message fold in too', (
      t,
    ) async {
      await open(t, []);
      expect(find.textContaining('comment'), findsNothing);
      r.event({
        'kind': 'comments',
        'items': [sent('a', 'the cache', 'why twice?')],
      });
      await t.pumpAndSettle();
      expect(find.text('1 comment'), findsOneWidget);
    });

    testWidgets('without the comments, the batch text shows folded', (t) async {
      await open(t, [], text: batch);
      expect(find.text('comments'), findsOneWidget);
      expect(find.textContaining('Comments on fragments'), findsNothing);
      expect(find.textContaining('> the cache'), findsNothing);
      await t.tap(find.text('comments'));
      await t.pumpAndSettle();
      expect(find.textContaining('the cache'), findsOneWidget);
      expect(find.textContaining('why twice?'), findsOneWidget);
      // the typed part stays in the bubble, without the batch
      expect(find.text('Look at this'), findsOneWidget);
    });

    testWidgets('a comment shows its voice clips and a media one its file', (
      t,
    ) async {
      await open(t, [
        sent('a', 'the cache', 'typed', voice: [clip('spoken words')]),
        {
          ...Comment(
            id: 'm',
            anchor: const MediaAnchor(
              source: FileSource(kind: 'file', path: 'shots/clip.mp4'),
              width: 100,
              height: 100,
              time: 65,
              shapes: [],
            ),
            text: 'look here',
            status: CommentStatus.sent,
            createdAt: 1,
          ).toJson(),
          'sentIn': 'u1',
        },
      ]);
      await t.tap(find.text('2 comments'));
      await t.pumpAndSettle();
      expect(find.textContaining('spoken words'), findsOneWidget);
      expect(find.textContaining('clip.mp4 @ 1:05'), findsOneWidget);
      expect(find.textContaining('look here'), findsOneWidget);
    });
  });
}
