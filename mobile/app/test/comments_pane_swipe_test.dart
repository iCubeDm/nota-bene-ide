import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'package:nb_app/comments/comments_pane.dart';
import 'package:nb_app/comments/swipe_delete.dart';
import 'comments_test.dart' show c, json;
import 'support/rig.dart';

// A swipe left on a pending comment of the Comments pane deletes it; the snackbar's Undo brings it back.
void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  Future<void> open(WidgetTester t, List<Comment> items) async {
    t.view.physicalSize = const Size(400, 800);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await r.open(t);
    r.event({
      'kind': 'comments',
      'items': [for (final x in items) json(x)],
    });
    await t.pumpAndSettle();
    await t.tap(find.text('Comments'));
    await t.pumpAndSettle();
  }

  Comment sent(String id, String text) => Comment(
    id: id,
    anchor: c(id, 'quote $id', text).anchor,
    text: text,
    status: CommentStatus.sent,
    createdAt: 1,
    sentIn: 'u1',
  );

  List<String> held() => [for (final x in r.tab!.comments.all) x.id];

  Finder row(String text) => find.textContaining(text);

  testWidgets('a swipe left deletes a pending comment and offers Undo', (
    t,
  ) async {
    await open(t, [c('a', 'qa', 'first'), c('b', 'qb', 'second')]);
    await t.drag(row('first'), const Offset(-400, 0));
    await t.pumpAndSettle();
    expect(row('first'), findsNothing);
    expect(row('second'), findsOneWidget);
    expect(held(), ['b']);
    expect(find.text('Comment deleted'), findsOneWidget);
    expect(r.sent.last['type'], 'comments');
    expect((r.sent.last['items'] as List).length, 1);
  });

  testWidgets('Undo puts it back in the same place and state', (t) async {
    await open(t, [c('a', 'qa', 'first'), c('b', 'qb', 'second')]);
    await t.drag(row('first'), const Offset(-400, 0));
    await t.pumpAndSettle();
    await t.tap(find.text('Undo'));
    await t.pumpAndSettle();
    expect(held(), ['a', 'b']);
    expect(row('first'), findsOneWidget);
    expect(
      t.getTopLeft(row('first')).dy,
      lessThan(t.getTopLeft(row('second')).dy),
    );
    final back = (r.sent.last['items'] as List).cast<Map>();
    expect([for (final i in back) i['id']], ['a', 'b']);
    expect(back.first['status'], 'pending');
  });

  testWidgets('a sent comment does not swipe away', (t) async {
    await open(t, [c('a', 'qa', 'first'), sent('s', 'old note')]);
    await t.tap(find.byKey(const ValueKey('sent-fold')));
    await t.pumpAndSettle();
    await t.drag(row('old note'), const Offset(-400, 0));
    await t.pumpAndSettle();
    expect(row('old note'), findsOneWidget);
    expect(held(), ['a', 's']);
    expect(
      find.ancestor(of: row('old note'), matching: find.byType(SwipeDelete)),
      findsNothing,
    );
  });

  testWidgets('a tap on a swipeable row still goes to its place', (t) async {
    await open(t, [
      c('a', 'qa', 'first', source: const AnchorSourceMessage(id: 'u0')),
    ]);
    final strip = find.byKey(const ValueKey('strip-current'));
    final before = t.getCenter(strip).dx;
    // the whole row is the target, not only its text
    await t.tapAt(Offset(390, t.getCenter(row('first')).dy));
    await t.pumpAndSettle();
    expect(t.getCenter(strip).dx, isNot(before));
  });

  testWidgets('a swipe right on a pending row goes back to Chat', (t) async {
    await open(t, [c('a', 'qa', 'first')]);
    final strip = find.byKey(const ValueKey('strip-current'));
    final before = t.getCenter(strip).dx;
    await t.drag(row('first'), const Offset(300, 0));
    await t.pumpAndSettle();
    expect(t.getCenter(strip).dx, lessThan(before));
    expect(held(), ['a']);
  });

  testWidgets('a comment on its way with a message is not swipeable', (
    t,
  ) async {
    await open(t, [c('a', 'qa', 'first')]);
    r.tab!.comments.sending({'a'});
    await t.pumpAndSettle();
    expect(find.byType(SwipeDelete), findsNothing);
    await t.drag(row('first'), const Offset(-400, 0));
    await t.pumpAndSettle();
    expect(held(), ['a']);
  });

  testWidgets('Undo does not bring back a comment that has been sent', (
    t,
  ) async {
    await open(t, [c('a', 'qa', 'first'), c('b', 'qb', 'second')]);
    await t.drag(row('first'), const Offset(-400, 0));
    await t.pumpAndSettle();
    r.tab!.comments.sending({'a'});
    await t.tap(find.text('Undo'));
    await t.pumpAndSettle();
    expect(held(), ['b']);
  });

  testWidgets('leaving the pane takes the Undo snackbar away', (t) async {
    await open(t, [c('a', 'qa', 'first')]);
    await t.drag(row('first'), const Offset(-400, 0));
    await t.pumpAndSettle();
    expect(find.text('Comment deleted'), findsOneWidget);
    final nav = Navigator.of(t.element(find.byType(CommentsPane)));
    nav.pushReplacement(
      MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('x'))),
    );
    await t.pumpAndSettle();
    expect(find.text('Comment deleted'), findsNothing);
  });
}
