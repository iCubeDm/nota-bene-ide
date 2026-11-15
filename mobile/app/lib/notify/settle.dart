// Waiting for the hosts to answer, for a check: a link is settled when it is offline or unpaired, or online with a window
// list received since it connected (online comes at the handshake, the list after it).
import 'dart:async';

import '../hosts/host_link.dart';

Future<void> linksSettled(Links links, Duration wait) async {
  bool settled(HostLink l) => switch (l.state) {
    LinkState.connecting => false,
    LinkState.online => l.lists > 0,
    _ => true,
  };
  final done = Completer<void>();
  void look() {
    if (links.all.every(settled) && !done.isCompleted) done.complete();
  }

  links.addListener(look);
  final timer = Timer(wait, () {
    if (!done.isCompleted) done.complete();
  });
  look();
  await done.future;
  timer.cancel();
  links.removeListener(look);
}
