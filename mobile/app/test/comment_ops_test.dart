import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comments.dart';
import 'package:nb_app/comments/queue.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'support/rig.dart';
import 'support/voice_fakes.dart';

Comment c(
  String id, {
  String text = 't',
  CommentStatus status = CommentStatus.pending,
}) => Comment(
  id: id,
  anchor: const TextAnchor(
    source: AnchorSourceFile(path: 'docs/plan.md'),
    start: 0,
    end: 1,
    quote: 'q',
    prefix: '',
    suffix: '',
  ),
  text: text,
  status: status,
  createdAt: 1,
);

/// A file whose first read waits for [loaded].
class SlowFile extends MemoryQueueFile {
  final loaded = Completer<void>();

  @override
  Future<String?> read() async {
    await loaded.future;
    return this.json;
  }
}

/// The window's side of the ops (protocol 19): what was sent, and whether the tab is open.
class Window {
  var open = true;
  var session = 's1';
  final sent = <ClientMessage>[];

  late final Comments cs;

  Window({CommentQueue? queue, num? protocol = 19}) {
    cs = Comments(
      (m) {
        if (!open) return false;
        sent.add(m);
        return true;
      },
      () => session,
      queue: queue,
    );
    if (protocol != null) cs.hello(protocol);
  }

  List<ClientMessageCommentOp> get ops =>
      sent.whereType<ClientMessageCommentOp>().toList();

  List<String> get shown => [for (final x in cs.all) x.id];
}

void main() {
  group('comment ops (protocol 19)', () {
    test(
      'an add shows at once, goes as an op, and leaves the queue on its ack',
      () {
        final w = Window();
        w.cs.apply([c('a')]);
        final n = w.cs.add(c('x').anchor, 'mine', null, id: 'n');
        expect(w.shown, ['a', 'n']);
        final op = w.ops.single;
        expect(op.sessionId, 's1');
        expect((op.ops.single as CommentOpAdd).comment.id, n.id);
        // a set from before ours keeps it on top; the set with its ack is the server's
        w.cs.apply([c('a')]);
        expect(w.shown, ['a', 'n']);
        w.cs.apply([c('a')], ack: [op.opId]);
        expect(w.shown, ['a']);
        expect(w.sent.whereType<ClientMessageComments>(), isEmpty);
      },
    );

    test(
      'changes made offline show, and go in order once the tab is open; each once per socket',
      () {
        final w = Window()..open = false;
        w.cs.apply([c('a'), c('b')]);
        w.cs.add(c('x').anchor, 'new', null, id: 'n');
        w.cs.edit('a', 'better', null);
        w.cs.remove('b');
        expect(w.shown, ['a', 'n']);
        expect(w.cs.all.first.text, 'better');
        // the server's set still has b: the queued remove keeps it hidden
        w.cs.apply([c('a'), c('b')]);
        expect(w.shown, ['a', 'n']);
        w.open = true;
        w.cs.flush();
        expect(
          [for (final o in w.ops) o.ops.single.runtimeType],
          [CommentOpAdd, CommentOpEdit, CommentOpRemove],
        );
        w.cs.flush();
        w.cs.apply([c('a'), c('b')]);
        expect(w.ops.length, 3);
        // a new socket: what was not acked goes again
        w.cs.hello(19);
        w.cs.flush();
        expect(w.ops.length, 6);
      },
    );

    test('nothing goes before the first hello', () {
      final w = Window(protocol: null);
      w.cs.add(c('x').anchor, 'new', null, id: 'n');
      w.cs.apply([]);
      expect(w.sent, isEmpty);
      expect(w.shown, ['n']);
      w.cs.hello(19);
      w.cs.flush();
      expect(w.ops.length, 1);
    });

    test(
      'a refusal: gone or sent drops the change and says so; failed keeps it for the next socket',
      () async {
        final w = Window();
        final told = <void>[];
        final sub = w.cs.changedElsewhere.listen(told.add);
        w.cs.apply([c('a', text: 'theirs')]);
        w.cs.edit('a', 'mine', null);
        expect(w.cs.all.single.text, 'mine');
        w.cs.refused(w.ops.last.opId, CommentRefusal.gone);
        expect(w.cs.all.single.text, 'theirs');
        w.cs.edit('a', 'again', null);
        w.cs.refused(w.ops.last.opId, CommentRefusal.failed);
        expect(w.cs.all.single.text, 'again');
        w.cs.flush();
        w.cs.apply([c('a', text: 'theirs')]);
        expect(w.ops.length, 2);
        w.cs.hello(19);
        w.cs.flush();
        expect(w.ops.length, 3);
        await Future<void>.delayed(Duration.zero);
        expect(told.length, 1);
        await sub.cancel();
      },
    );

    test(
      'an op of another session is not shown here; its comment-ack takes it off the queue',
      () {
        final w = Window()..open = false;
        w.cs.add(c('x').anchor, 'there', null, id: 'n');
        w.session = 's2';
        w.cs.apply([c('a')]);
        expect(w.shown, ['a']);
        w.open = true;
        w.cs.flush();
        expect(w.ops.single.sessionId, 's1');
        w.cs.acked(w.ops.single.opId);
        w.cs.hello(19);
        w.cs.flush();
        expect(w.ops.length, 1);
      },
    );

    test(
      'Undo of a deletion brings the comment back where it was, as a restore',
      () {
        final w = Window();
        w.cs.apply([c('a'), c('b'), c('d')]);
        final b = w.cs.all[1];
        w.cs.remove('b');
        w.cs.restore(b, 1);
        expect(w.shown, ['a', 'b', 'd']);
        final add = w.ops.last.ops.single as CommentOpAdd;
        expect((add.comment.id, add.before, add.restore), ('b', 'd', true));
        // the last one goes back to the end
        final d = w.cs.all[2];
        w.cs.remove('d');
        w.cs.restore(d, 2);
        expect((w.ops.last.ops.single as CommentOpAdd).before, isNull);
        expect(w.shown, ['a', 'b', 'd']);
      },
    );

    test(
      'a window older than 19 gets the set with the queued changes, once, and the queue is done',
      () {
        final w = Window(protocol: null)..open = false;
        w.cs.add(c('x').anchor, 'new', null, id: 'n');
        w.cs.hello(13);
        w.cs.apply([c('a')]);
        expect(w.sent, isEmpty);
        w.open = true;
        w.cs.apply([c('a')]);
        final set = w.sent.whereType<ClientMessageComments>().single;
        expect([for (final x in set.items) x.id], ['a', 'n']);
        w.cs.flush();
        expect(w.sent.length, 1);
        expect(w.ops, isEmpty);
      },
    );
  });

  group('the queue on disk', () {
    test(
      'changes made offline outlive the app and go to the window of the next run',
      () async {
        final file = MemoryQueueFile();
        final before = Window(queue: CommentQueues(file).of('h|s1'))
          ..open = false;
        before.cs.apply([c('a'), c('b')]);
        before.cs.add(c('x').anchor, 'new', null, id: 'n');
        before.cs.edit('a', 'better', null);
        before.cs.remove('b');
        await pumpEventQueue();
        expect(jsonDecode(file.json!), contains('h|s1'));

        final queues = CommentQueues(file);
        final after = Window(queue: queues.of('h|s1'), protocol: null);
        await queues.ready;
        await pumpEventQueue();
        after.cs.apply([c('a'), c('b')]);
        expect(after.shown, ['a', 'n']);
        expect(after.cs.all.first.text, 'better');
        after.cs.hello(19);
        after.cs.flush();
        expect(after.ops.length, 3);
        // acked, they leave the disk too
        after.cs.apply(
          [c('a', text: 'better'), c('n')],
          ack: [for (final o in after.ops) o.opId],
        );
        await pumpEventQueue();
        expect(jsonDecode(file.json!), isEmpty);
        // another window's queue is its own
        expect(Window(queue: CommentQueues(file).of('h|s2')).shown, isEmpty);
      },
    );

    test(
      'a change made before the file was read keeps what the file had',
      () async {
        final file = SlowFile();
        final old = Window(queue: CommentQueues(MemoryQueueFile()).of('k'));
        old.cs.add(c('x').anchor, 'old', null, id: 'o');
        file.json = jsonEncode({
          'k': [for (final o in old.ops) o.toJson()],
        });
        final queues = CommentQueues(file);
        final w = Window(queue: queues.of('k'))..open = false;
        w.cs.add(c('x').anchor, 'new', null, id: 'n');
        file.loaded.complete();
        await queues.ready;
        await pumpEventQueue();
        expect(w.shown, ['o', 'n']);
        final kept = (jsonDecode(file.json!) as Map)['k'] as List;
        expect(kept.length, 2);
      },
    );
  });

  testWidgets(
    'the chat says when the window refused a change: the comment changed elsewhere',
    (t) async {
      final r = Rig();
      await r.open(
        t,
        hello: {'kind': 'hello', 'protocol': 19, 'capabilities': Rig.caps()},
      );
      r.event({
        'kind': 'comments',
        'items': [c('a').toJson()],
      });
      await t.pump();
      r.tab!.comments.edit('a', 'mine', null);
      final op = r.sent.lastWhere((m) => m['type'] == 'comment-op');
      expect((op['ops'] as List).single, containsPair('op', 'edit'));
      r.event({
        'kind': 'comment-refused',
        'opId': op['opId'],
        'reason': 'gone',
      });
      await t.pump();
      expect(
        find.text(
          'A comment was changed or deleted in another window, so your change was not applied',
        ),
        findsOneWidget,
      );
      expect(r.tab!.comments.all.single.text, 't');
      // the set with the op's ack is the server's: what it says wins over the change
      r.tab!.comments.edit('a', 'mine again', null);
      final ed = r.sent.lastWhere((m) => m['type'] == 'comment-op');
      r.event({
        'kind': 'comments',
        'items': [c('a', text: 'merged').toJson()],
        'ack': [ed['opId']],
      });
      await t.pump();
      expect(r.tab!.comments.all.single.text, 'merged');
      r.dispose();
    },
  );

  testWidgets(
    'a change made before the window replayed goes once it does; a comment-ack ends it',
    (t) async {
      final r = Rig();
      await r.open(
        t,
        hello: {'kind': 'hello', 'protocol': 19, 'capabilities': Rig.caps()},
        replay: false,
      );
      r.tab!.comments.add(c('x').anchor, 'early', null, id: 'n');
      expect(r.sent.where((m) => m['type'] == 'comment-op'), isEmpty);
      r.event({'kind': 'replay', 'events': <Object?>[]});
      await t.pump();
      final op = r.sent.singleWhere((m) => m['type'] == 'comment-op');
      r.event({'kind': 'comment-ack', 'opId': op['opId']});
      await t.pump();
      // acked, it is not sent again on the next socket
      r.tab!.comments.hello(19);
      r.tab!.comments.flush();
      expect(r.sent.where((m) => m['type'] == 'comment-op').length, 1);
      r.dispose();
    },
  );
}
