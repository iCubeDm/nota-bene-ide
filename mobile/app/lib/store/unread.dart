// The unread count of a row (issue 174): the window's own (`unseen`, the replies after its read mark, which any client
// that looks moves). In memory, a chat read here (left, or marked read) shows none while the host lists the replies it
// had then: the list is polled, and the next one may still carry the count from before.
import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart';

class Unread extends ChangeNotifier {
  /// `hostId session` -> the replies it had when read here.
  final _read = <String, int>{};

  /// [w] of [hostId] was read here: the chat was left, or marked read.
  void read(String hostId, HostWindow w) {
    final session = w.session, replies = w.replies;
    if (session == null || replies == null) return;
    _read['$hostId $session'] = replies;
    notifyListeners();
  }

  /// The replies of [w] nobody has seen; 0 for an older host, which does not say.
  int of(String hostId, HostWindow w) {
    final held = _read['$hostId ${w.session}'];
    if (held != null && held == w.replies) return 0;
    return w.unseen ?? 0;
  }
}
