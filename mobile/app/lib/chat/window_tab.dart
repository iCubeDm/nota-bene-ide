// One window on the phone (issue 511): its [AgentConnection] (the socket, the one-tab rule, reconnects), its
// [Repository] (the window's data over it), its [WindowState] (what the window said) and the window's comments, voice
// outbox and media cache, wired together for the window's lifetime. The screens read the parts themselves (issue 547)
// and send through [WindowTab.send] and [WindowTab.sendVoice], giving the question (issue 565).

import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/comments.dart';
import '../files/repository.dart';
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

/// What a send asks while the agent works, as the desktop does: true sends now and interrupts, false waits for this
/// turn, null (dismissed) sends nothing.
typedef AskSendNow = Future<bool?> Function();

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

  /// The window's data (files, git) over it.
  late final repository = Repository(connection);

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
    has: connection.has,
    queue: stores.comments.of(_box),
  );

  /// The voice messages recorded for this window that it has not shown yet. They belong to the app, by host and
  /// window, and outlive this tab: leaving the chat loses none.
  late final voiceOutbox = stores.voice.outbox(_box);

  /// The attachments read for the feed's thumbnails and the viewer, by their request path, within a byte cap.
  final mediaCache = MediaCache();

  bool _disposed = false;

  /// Whether a send forces its way in: [ask] only while the agent works; null when it was dismissed.
  Future<bool?> _force(AskSendNow ask) async =>
      windowState.busy ? await ask() : false;

  /// Sends [text] with the pending comments in the desktop's batch and the images [images] gives, asking [ask] first
  /// while the agent works. The comments and the images are read after the question: the desktop may have sent or
  /// changed comments meanwhile, and an image added then goes too. The comments sent are marked sending. Null when
  /// nothing went: dismissed, nothing to send, or the window could not take it.
  Future<({String id, Set<String> comments})?> send(
    String text, {
    required String lang,
    required AskSendNow ask,
    List<ImageRef> Function()? images,
  }) async {
    final force = await _force(ask);
    if (force == null) return null;
    final pending = comments.sendable;
    final own = images?.call() ?? const <ImageRef>[];
    if (text.isEmpty && pending.isEmpty && own.isEmpty) return null;
    final batch = comments.compose(windowState, text, pending, lang, own: own);
    final id = uuidV4();
    final sent = connection.send(
      ClientMessageSend(
        id: id,
        text: batch.text,
        force: force ? true : null,
        commentIds: pending.isEmpty ? null : [for (final c in pending) c.id],
        images: batch.images.isEmpty ? null : batch.images,
      ),
    );
    if (!sent) return null;
    final ids = {for (final c in pending) c.id};
    comments.sending(ids);
    return (id: id, comments: ids);
  }

  /// Sends recording [wav] as a voice message of its own (never with text or images) through the outbox, after the
  /// same question as [send]; the pending comments ride along by id, their batch written when it leaves
  /// ([Comments.composeFor]). A window older than 16 gets the recording alone and they stay pending. False when [ask]
  /// was dismissed.
  Future<bool> sendVoice(
    Uint8List wav,
    String lang, {
    required bool detect,
    required String commentLang,
    required AskSendNow ask,
  }) async {
    final force = await _force(ask);
    if (force == null) return false;
    voiceOutbox.submit(
      wav,
      lang,
      detect: detect,
      force: force,
      commentIds: connection.has(Feature.voiceComments)
          ? [for (final c in comments.sendable) c.id]
          : const [],
      commentLang: commentLang,
    );
    return true;
  }

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

  /// An event of the window: the comments take theirs, the state all, then the voice outbox (while this tab is its
  /// chat) what it answered.
  void _event(ServerEvent e) {
    switch (e) {
      case ServerEventHello():
        comments.hello();
      case ServerEventComments(:final items, :final ack):
        comments.apply(items, ack: ack);
      case ServerEventCommentAck(:final opId):
        comments.acked(opId);
      case ServerEventCommentRefused(:final opId, :final reason):
        comments.refused(opId, reason);
      default:
    }
    windowState.apply(e);
    // the outbox is the app's: a tab that was replaced and is still closing must not touch the new tab's sends
    if (voiceOutbox.attachedTo(this)) {
      voiceOutbox.event(
        e,
        windowState,
        holdsUntold: connection.has(Feature.compactOrder),
      );
    }
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
