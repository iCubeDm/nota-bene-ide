import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comments.dart';
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
}
