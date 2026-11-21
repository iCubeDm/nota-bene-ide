// A streamed reply rebuilds the feed, not the chat around it (issue 565).
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_header.dart';
import 'package:nb_app/chat/chat_screen.dart';
import 'package:nb_app/chat/composer.dart';
import 'package:nb_app/chat/panes.dart';
import 'package:nb_app/chat/paragraph.dart';
import 'package:nb_app/comments/comment_strip.dart';
import 'package:nb_app/comments/comments_pane.dart';
import 'package:nb_app/files/files_pane.dart';

import 'support/rig.dart';

Map<String, Object?> agent(Map<String, Object?> e) => {
  'kind': 'agent',
  'e': e,
  'ts': 1,
};

void main() {
  testWidgets('a streamed reply rebuilds none of the chat but its feed', (
    t,
  ) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t, settle: false);
    r.event(agent({'t': 'turn-start'}));
    r.event(agent({'t': 'message-start'}));
    await t.pump();
    final built = <Type, int>{};
    debugOnRebuildDirtyWidget = (e, _) =>
        built.update(e.widget.runtimeType, (n) => n + 1, ifAbsent: () => 1);
    addTearDown(() => debugOnRebuildDirtyWidget = null);
    for (final w in ['one', ' two', ' three']) {
      r.event(agent({'t': 'message-chunk', 'text': w}));
      await t.pump();
    }
    debugOnRebuildDirtyWidget = null;
    expect(find.textContaining('one two three'), findsOneWidget);
    const around = [
      ChatScreen,
      ChatPanes,
      ChatHeader,
      Composer,
      CommentStrip,
      FilesPane,
      CommentsPane,
    ];
    expect(
      {for (final w in around) w: built[w] ?? 0},
      {for (final w in around) w: 0},
    );
  });

  testWidgets('the paragraph popup keeps clear of the field as it grows', (
    t,
  ) async {
    final r = Rig();
    addTearDown(r.dispose);
    await r.open(t);
    final targets = ParagraphHost.maybeOf(
      t.element(find.byKey(const ValueKey('feed'))),
    )!;
    double band() =>
        t.getSize(find.byKey(const ValueKey('band-solid-bottom'))).height;
    expect(targets.bottomInset, band());
    final before = band();
    await t.enter('one\ntwo\nthree\nfour');
    expect(band(), greaterThan(before));
    expect(targets.bottomInset, band());
  });
}
