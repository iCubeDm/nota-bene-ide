import 'package:flutter_test/flutter_test.dart';
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
}
