// What the header pill's second line says: the state of the session, as a messenger says "typing…" or "last seen".
// One place decides it (the pill, and its colour, read it); the order is the strongest cause first: no window or link,
// a question waiting for the user, a compaction, a turn, else idle.
import 'package:intl/intl.dart';

import '../hosts/host_link.dart' show LinkState;
import '../hosts/hosts_screen.dart' show ago;
import '../l10n/app_localizations.dart';
import 'feed.dart';
import 'window_tab.dart';

enum SessionPhase { reading, searching, editing, running, delegating }

/// What the running tool of the turn does, or null when no tool runs or the app does not know the tool.
SessionPhase? sessionPhase(Feed f) {
  if (!f.busy) return null;
  for (final it in f.items.reversed) {
    if (it is ToolItem && it.result == null) {
      return switch (it.name.toLowerCase()) {
        'read' || 'notebookread' => SessionPhase.reading,
        'grep' ||
        'glob' ||
        'ls' ||
        'find' ||
        'search' ||
        'websearch' ||
        'webfetch' => SessionPhase.searching,
        'edit' ||
        'multiedit' ||
        'write' ||
        'notebookedit' ||
        'apply_patch' => SessionPhase.editing,
        'bash' || 'shell' || 'exec' => SessionPhase.running,
        'task' || 'agent' => SessionPhase.delegating,
        _ => null,
      };
    }
    // the turn's own tools only: a user message ends the search
    if (it is UserItem) return null;
  }
  return null;
}

/// A question to the user (a permission or a plan) is open and nobody has answered it.
bool awaitsAnswer(Feed f) =>
    f.items.any((i) => i is PermissionItem && i.answer == null && !i.archived);

/// Whether the agent acts or waits for the user: the pill's line takes the accent colour.
bool sessionActive(WindowTab tab) =>
    tab.state == TabState.open &&
    (tab.busy || tab.feed.compacting || awaitsAnswer(tab.feed));

String elapsedText(Duration d) {
  final s = d.inSeconds < 0 ? 0 : d.inSeconds;
  final sec = (s % 60).toString().padLeft(2, '0');
  final m = (s ~/ 60) % 60;
  final h = s ~/ 3600;
  return h > 0 ? '$h:${m.toString().padLeft(2, '0')}:$sec' : '$m:$sec';
}

String phaseText(AppLocalizations t, SessionPhase p) => switch (p) {
  SessionPhase.reading => t.phaseReading,
  SessionPhase.searching => t.phaseSearching,
  SessionPhase.editing => t.phaseEditing,
  SessionPhase.running => t.phaseRunning,
  SessionPhase.delegating => t.phaseDelegating,
};

/// The second line of the pill at [now].
String sessionLine(
  AppLocalizations t,
  WindowTab tab,
  DateTime now,
  String locale,
) {
  switch (tab.state) {
    case TabState.connecting:
      return t.stateConnecting;
    case TabState.offline:
      final l = tab.link;
      if (l.state == LinkState.connecting) return t.stateConnecting;
      return l.lastSeen == null
          ? t.stateOffline
          : t.stateOfflineSeen(ago(t, now.difference(l.lastSeen!)));
    case TabState.gone:
      return t.stateWaitingWindow;
    case TabState.occupied || TabState.taken:
      return t.stateOtherTab;
    case TabState.open:
      break;
  }
  final f = tab.feed;
  if (tab.state == TabState.open) {
    if (awaitsAnswer(f)) return t.stateWaitingAnswer;
    if (f.compacting) return t.stateCompacting;
    if (tab.busy) {
      final phase = sessionPhase(f);
      final since = tab.busySince;
      return phase == null || since == null
          ? t.stateWorking
          : t.stateWorkingPhase(
              phaseText(t, phase),
              elapsedText(now.difference(since)),
            );
    }
  }
  final done = tab.lastDoneAt;
  return done == null
      ? t.stateOnline
      : t.stateOnlineDone(DateFormat.Hm(locale).format(done));
}
