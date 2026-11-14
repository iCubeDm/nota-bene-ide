import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/notify/visible.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';

HostWindow win(int replies) => HostWindow(
  port: 4791,
  provider: 'claude',
  root: '/home/u/notes',
  session: 's1',
  replies: replies,
);

void main() {
  testWidgets('an open chat sees every new reply of its window', (t) async {
    final seen = await Seen.load(MemoryVault());
    final rig = Rig();
    await rig.open(t, seen: seen, win: win(2));
    final hostId = rig.link.host.id;
    expect(seen.seenOf(hostId, 's1'), 2);
    rig.ch.push([win(3)]);
    await t.pumpAndSettle();
    expect(seen.seenOf(hostId, 's1'), 3);
    expect(seen.unread(hostId, win(3)), 0);
    rig.dispose();
  });

  testWidgets(
    'a hidden app\'s open chat does not see a new reply; showing it does',
    (t) async {
      final seen = await Seen.load(MemoryVault());
      final visible = AppVisible.test(visible: true);
      final rig = Rig();
      await rig.open(t, seen: seen, win: win(2), visible: visible);
      final hostId = rig.link.host.id;
      expect(visible.chat, (hostId: hostId, port: 4791, root: '/home/u/notes'));
      visible.visible = false;
      rig.ch.push([win(3)]);
      await t.pumpAndSettle();
      expect(seen.seenOf(hostId, 's1'), 2, reason: 'nobody is looking');
      expect(visible.onScreen(hostId, win(3)), isFalse);
      visible.visible = true;
      await t.pumpAndSettle();
      expect(seen.seenOf(hostId, 's1'), 3);
      expect(visible.onScreen(hostId, win(3)), isTrue);
      await t.pumpWidget(const SizedBox());
      expect(visible.chat, isNull, reason: 'the chat left');
      rig.dispose();
    },
  );
}
