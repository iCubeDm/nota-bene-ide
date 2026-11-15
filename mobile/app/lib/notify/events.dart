// What deserves a notification in a host's window list: a final reply the phone has neither shown nor notified, and an
// agent that starts waiting for the user (a permission, a question, a plan).
import 'dart:async';

import 'package:nb_channel/nb_channel.dart';

import '../store/notified.dart';
import '../store/seen.dart';

sealed class AgentEvent {
  AgentEvent(this.hostId, this.w) : project = projectOf(w);

  final String hostId;
  final HostWindow w;
  final String project;

  int get port => w.port;
  String get root => w.root;
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

/// The window's title, else the last segment of its folder.
String projectOf(HostWindow w) {
  final title = w.title?.trim();
  if (title != null && title.isNotEmpty) return title;
  final parts = w.root.split(RegExp(r'[/\\]')).where((p) => p.isNotEmpty);
  return parts.isEmpty ? w.root : parts.last;
}

const _textMax = 120;

/// The events of [windows] for [hostId], recorded in [notified] (saved once when anything changed). A session not in
/// [seen] yet gives no reply event: Seen counts it as seen up to its replies. The session [onScreen] gives none, but
/// its counts still advance, so leaving its chat does not notify old things.
List<AgentEvent> detect(
  String hostId,
  List<HostWindow> windows,
  Seen seen,
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
    var r = was?.replies ?? seen.seenOf(hostId, session);
    var waiting = was?.waiting ?? false;
    if (replies != null) {
      if (replies < r) {
        r = replies; // a new history: count from here
      } else if (replies > r) {
        if (!here && replies > seen.seenOf(hostId, session)) {
          final last = w.last;
          final text = last != null && last.role == 'assistant'
              ? _cut(last.text)
              : null;
          events.add(ReplyEvent(hostId, w, text));
        }
        r = replies;
      }
    }
    if (w.pending && !waiting) {
      if (!here) events.add(WaitEvent(hostId, w));
      waiting = true;
    } else if (!w.pending) {
      waiting = false;
    }
    if (was == null || was.replies != r || was.waiting != waiting) {
      notified.put(hostId, session, (replies: r, waiting: waiting));
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
