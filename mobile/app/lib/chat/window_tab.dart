// One window on the phone (issue 511): its [AgentConnection] (the socket, the one-tab rule, reconnects), its
// [WindowState] (what the window said) and the window's comments, voice outbox and media cache, wired together for
// the window's lifetime. The screens read the parts themselves (issue 547).

import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/comments.dart';
import '../hosts/host_link.dart';
import '../media/fetch.dart';
import '../sdk.dart';
import 'agent_connection.dart';
import 'window_state.dart';

export 'agent_connection.dart' show TabState, takenOverCode, uuidV4;

/// The modes the agent offers (the known ones, in its order).
List<AgentMode> offeredModes(WindowTab tab) => [
  for (final m in tab.windowState.capabilities?.modes ?? const <AgentMode>[])
    if (m != AgentMode.$unknown) m,
];

/// The mode to show: the web's mode pill is hidden below two modes (ModePill.tsx), and a mode the agent does not
/// offer is not shown.
AgentMode? shownMode(WindowTab tab) {
  final m = tab.windowState.mode;
  final modes = offeredModes(tab);
  return m != null && modes.length >= 2 && modes.contains(m) ? m : null;
}

/// Whether the window transcribes the phone's recordings now.
bool transcribes(WindowTab tab) =>
    tab.connection.state == TabState.open &&
    (tab.windowState.whisperOn ??
        tab.windowState.capabilities?.dictation == 'whisper');

/// The modes that act without asking (the user is not prompted): shown in the danger colour.
bool modeWithoutPrompts(AgentMode m) =>
    m == AgentMode.auto ||
    m == AgentMode.codexFullAccess ||
    m == AgentMode.ompYolo;

class WindowTab extends ChangeNotifier {
  WindowTab(
    HostLink link,
    HostWindow w, {
    required this.stores,
    Future<void> Function(Duration)? retry,
  }) {
    connection = AgentConnection(
      link,
      w,
      onEvent: _event,
      onSocket: _socket,
      onOpen: _opened,
      retry: retry,
    );
    voiceOutbox.attach(
      this,
      send: connection.send,
      http: () => connection.http,
      compose: (ids, lang) => comments.composeFor(windowState, ids, lang),
      canDetect: () => connection.has(Feature.voiceDetect),
    );
    comments.held = () => voiceOutbox.heldIds;
    voiceOutbox.addListener(comments.refresh);
    connection.addListener(_notify);
    windowState.addListener(_notify);
    connection.start();
  }

  /// The window's socket: the one-tab rule, reconnects, sends.
  late final AgentConnection connection;

  /// What the window said over it.
  late final windowState = WindowState(
    send: connection.send,
    http: () => connection.http,
  );

  /// The app's stores: this window's comment queue and voice outbox are among them.
  final AppStores stores;

  /// What the app keeps for this window beyond the tab, by host and session (the project before the host lists one).
  late final String _box =
      '${connection.link.host.id}|${connection.window?.session ?? connection.root}';

  /// The window's comments of this session (the server's set), with the changes made here it has not acked, which
  /// outlive the app.
  late final comments = Comments(
    connection.send,
    () => windowState.feed.sessionId,
    queue: stores.comments.of(_box),
  );

  /// The voice messages recorded for this window that it has not shown yet. They belong to the app, by host and
  /// window, and outlive this tab: leaving the chat loses none.
  late final voiceOutbox = stores.voice.outbox(_box);

  /// The attachments read for the feed's thumbnails and the viewer, by their request path, within a byte cap.
  final mediaCache = MediaCache();

  bool _disposed = false;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// A new socket: the comment queue waits for its hello (issue 494), and the window says its state again.
  void _socket() {
    comments.closed();
    windowState.socket();
  }

  /// What waited for the window goes on now that it takes messages.
  void _opened() {
    voiceOutbox.opened();
    comments.flush();
  }

  /// An event of the window: the comments take theirs, the state all, then the voice outbox what it answered.
  void _event(ServerEvent e) {
    switch (e) {
      case ServerEventHello(:final protocol):
        comments.hello(protocol);
      case ServerEventComments(:final items, :final ack):
        comments.apply(items, ack: ack);
      case ServerEventCommentAck(:final opId):
        comments.acked(opId);
      case ServerEventCommentRefused(:final opId, :final reason):
        comments.refused(opId, reason);
      default:
    }
    windowState.apply(e);
    voiceOutbox.event(
      e,
      windowState,
      holdsUntold: connection.has(Feature.compactOrder),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    connection.dispose();
    windowState.dispose();
    voiceOutbox.removeListener(comments.refresh);
    voiceOutbox.detach(this);
    super.dispose();
  }
}
