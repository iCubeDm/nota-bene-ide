// The unread count of a row is the window's (`unseen`, issue 174), held at 0 for a chat read here until its next reply.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/store/unread.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';

HostWindow win({int replies = 2, int? unseen = 1}) => HostWindow(
  port: 4791,
  provider: AgentProvider.claude,
  root: '/home/u/notes',
  session: 's1',
  replies: replies,
  unseen: unseen,
);

void main() {
  test(
    'the count is the window\'s; read here it is 0 until a reply after it',
    () {
      final u = Unread();
      expect(u.of('h', win()), 1);
      expect(u.of('h', win(unseen: null)), 0, reason: 'an older host');
      u.read('h', win());
      expect(u.of('h', win()), 0, reason: 'the poll still has the old count');
      expect(u.of('h', win(replies: 3, unseen: 1)), 1);
      expect(u.of('other', win()), 1);
    },
  );

  testWidgets('leaving a chat reads its window here', (t) async {
    final rig = Rig();
    await rig.open(t, win: win());
    final unread = rig.stores!.unread;
    expect(unread.of(rig.link.host.id, win()), 1);
    await t.pumpWidget(const SizedBox());
    expect(unread.of(rig.link.host.id, win()), 0);
    rig.dispose();
  });
}
