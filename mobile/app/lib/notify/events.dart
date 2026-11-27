// What deserves a notification in a host's window list: a final reply nobody has read (the window's `unseen`, issue
// 174) that the phone has not notified, and an agent that starts waiting for the user (a permission, a question, a
// plan); and a notification that is read now, on any client.
import 'dart:async';

import 'package:nb_channel/nb_channel.dart';

import '../store/notified.dart';

sealed class AgentEvent {
  AgentEvent(this.hostId, this.w) : project = projectOf(w);

  final String hostId;
  final HostWindow w;
  final String project;

  String get session => w.session!;

  /// One notification per session: the next event of a session replaces it.
  String get key => '$hostId $session';
}

class ReplyEvent extends AgentEvent {
  ReplyEvent(super.hostId, super.w, this.text);

  /// The start of the agent's reply; null when the last message is not the agent's.
  final String? text;
}

class WaitEvent extends AgentEvent {
  WaitEvent(super.hostId, super.w);
}

/// The session's replies were read (its `unseen` dropped to 0): its notification goes.
class ReadEvent extends AgentEvent {
  ReadEvent(super.hostId, super.w);
}

/// The window's title, else the last segment of its folder.
String projectOf(HostWindow w) {
  final title = w.title?.trim();
  if (title != null && title.isNotEmpty) return title;
  final parts = w.root.split(RegExp(r'[/\\]')).where((p) => p.isNotEmpty);
  return parts.isEmpty ? w.root : parts.last;
}

const _textMax = 120;

/// The events of [windows] for [hostId], recorded in [notified] (saved once when anything changed). A session met for
/// the first time gives no reply event: its replies so far are no news. A reply notifies while the window says it is
/// unread (an older host, which says nothing: always). The session [onScreen] gives none, but its counts still advance,
/// so leaving its chat does not notify old things.
List<AgentEvent> detect(
  String hostId,
  List<HostWindow> windows,
  Notified notified, {
  bool Function(String hostId, HostWindow w)? onScreen,
}) {
  final events = <AgentEvent>[];
  var changed = false;
  for (final w in windows) {
    final session = w.session, replies = w.replies;
    if (session == null) continue;
    final was = notified.of(hostId, session);
    final here = onScreen?.call(hostId, w) ?? false;
    final unseen = w.unseen;
    var r = was?.replies ?? replies ?? 0;
    var waiting = was?.waiting ?? false;
    if (replies != null) {
      if (replies < r) {
        r = replies; // a new history: count from here
      } else if (replies > r) {
        if (!here && (unseen == null || unseen > 0)) {
          final last = w.last;
          final text = last != null && last.role == LastMessageRole.assistant
              ? _cut(last.text)
              : null;
          events.add(ReplyEvent(hostId, w, text));
        }
        r = replies;
      }
    }
    final pending = w.pending == true;
    if (pending && !waiting) {
      if (!here) events.add(WaitEvent(hostId, w));
      waiting = true;
    } else if (!pending) {
      waiting = false;
    }
    if (unseen == 0 && (was?.unseen ?? 0) > 0) events.add(ReadEvent(hostId, w));
    if (was == null ||
        was.replies != r ||
        was.waiting != waiting ||
        was.unseen != unseen) {
      notified.put(hostId, session, (
        replies: r,
        waiting: waiting,
        unseen: unseen,
      ));
      changed = true;
    }
  }
  if (changed) unawaited(notified.save());
  return events;
}

String _cut(String s) {
  final t = s.trim().replaceAll(RegExp(r'\s+'), ' ');
  return t.length <= _textMax ? t : '${t.substring(0, _textMax)}…';
}
