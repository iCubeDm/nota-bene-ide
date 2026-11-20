// One window on the phone (issue 511): its [WindowConnection] (the socket, the one-tab rule, reconnects), its
// [WindowState] (what the window said) and the window's comments, voice outbox and media cache, wired together. The
// screens read the window through it.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/comments.dart';

import '../hosts/host_link.dart';
import '../media/fetch.dart';
import '../media/media_comment.dart' show WindowHttp;
import '../sdk.dart';
import 'feed.dart';
import 'window_connection.dart';
import 'window_state.dart';

export 'window_connection.dart' show TabState, takenOverCode, uuidV4;

/// The modes the agent offers (the known ones, in its order).
List<AgentMode> offeredModes(WindowTab tab) => [
  for (final m in tab.capabilities?.modes ?? const <AgentMode>[])
    if (m != AgentMode.$unknown) m,
];

/// The mode to show: the web's mode pill is hidden below two modes (ModePill.tsx), and a mode the agent does not
/// offer is not shown.
AgentMode? shownMode(WindowTab tab) {
  final m = tab.mode;
  final modes = offeredModes(tab);
  return m != null && modes.length >= 2 && modes.contains(m) ? m : null;
}

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
    connection = WindowConnection(
      link,
      w,
      onEvent: _event,
      onSocket: _socket,
      onOpen: _opened,
      retry: retry,
    );
    voiceOutbox.attach(
      this,
      send: send,
      http: () => http,
      compose: composeFor,
      canDetect: () => detectProtocolOk,
    );
    comments.held = () => voiceOutbox.heldIds;
    voiceOutbox.addListener(comments.refresh);
    connection.addListener(_notify);
    windowState.addListener(_notify);
    connection.start();
  }

  /// The window's socket: the one-tab rule, reconnects, sends.
  late final WindowConnection connection;

  /// What the window said over it.
  late final windowState = WindowState(send: send, http: () => http);

  /// The app's stores: this window's comment queue and voice outbox are among them.
  final AppStores stores;

  /// What the app keeps for this window beyond the tab, by host and session (the project before the host lists one).
  late final String _box = '${link.host.id}|${window?.session ?? root}';

  /// The window's comments of this session (the server's set), with the changes made here it has not acked, which
  /// outlive the app.
  late final comments = Comments(
    send,
    () => feed.sessionId,
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

  // the connection's
  HostLink get link => connection.link;
  String get key => connection.key;
  String get root => connection.root;
  HostWindow? get window => connection.window;
  int get port => connection.port;
  String get tabId => connection.tabId;
  TabState get state => connection.state;
  num? get protocol => connection.protocol;
  WindowHttp? get http => connection.http;
  bool send(ClientMessage m) => connection.send(m);
  void reopen() => connection.reopen();
  void takeOver() => connection.takeOver();

  /// Whether the window can detect the spoken language (protocol 18); an older one gets the language alone.
  bool get detectProtocolOk => connection.has(Feature.voiceDetect);

  /// Whether the window speaks protocol 14, where voice messages begin.
  bool get voiceProtocol => connection.has(Feature.voice);

  /// Whether a voice message may carry the pending comments (protocol 16); an older window gets the recording alone.
  bool get voiceCommentsProtocol => connection.has(Feature.voiceComments);

  /// Whether the window orders a Compact while the agent works for its next pause (protocol 27).
  bool get canOrderCompact => connection.has(Feature.compactOrder);

  // the window state's
  Feed get feed => windowState.feed;
  FeedUi get feedUi => windowState.feedUi;
  List<ModelOption> get models => windowState.models;
  String? get model => windowState.model;
  AgentEffort? get effort => windowState.effort;
  AgentMode? get mode => windowState.mode;
  Map<String, String> get fileVersions => windowState.fileVersions;
  Capabilities? get capabilities => windowState.capabilities;
  List<String> get tmpDirs => windowState.tmpDirs;
  bool? get whisperOn => windowState.whisperOn;
  set whisperOn(bool? on) => windowState.whisperOn = on;
  ServerEventStats? get stats => windowState.stats;
  IdleCompact? get idleCompact => windowState.idleCompact;
  bool get compactPending => windowState.compactPending;
  List<HeldSend> get held => windowState.held;
  bool get restartPending => windowState.restartPending;
  bool get orderWaits => windowState.orderWaits;
  DateTime? get lastDoneAt => windowState.lastDoneAt;
  DateTime? get busySince => windowState.busySince;
  DateTime Function() get clock => windowState.clock;
  set clock(DateTime Function() c) => windowState.clock = c;
  Stream<ServerEventSendRefused> get refusals => windowState.refusals;
  Stream<ServerEventServerError> get errors => windowState.errors;
  bool get busy => windowState.busy;
  bool setMode(AgentMode m) => windowState.setMode(m);
  bool toggleIdleCompact() => windowState.toggleIdleCompact();
  Future<void> loadEarlier() => windowState.loadEarlier();

  /// Whether the window transcribes the phone's recordings now.
  bool get whisper =>
      state == TabState.open &&
      (whisperOn ?? capabilities?.dictation == 'whisper');

  // message id -> voice id of the Retry sends the window has not answered yet
  final _retrying = <String, String>{};

  /// A Retry of voice [voiceId] is out: pressing it again would send the message twice.
  bool isRetrying(String voiceId) => _retrying.containsValue(voiceId);

  /// Sends [voice] again as a new message (the Retry of a failed bubble). False when the window did not take it.
  bool retryVoice(Voice voice, String lang, {bool detect = false}) {
    if (isRetrying(voice.id)) return true;
    final id = uuidV4();
    if (!send(
      ClientMessageSend(
        id: id,
        text: '',
        voice: voice,
        lang: lang,
        detect: detect && detectProtocolOk ? true : null,
      ),
    )) {
      return false;
    }
    _retrying[id] = voice.id;
    _notify();
    return true;
  }

  /// The batch the agent gets for [items] (after [general]), as the desktop writes it, with the images that go along:
  /// one place for the typed send, the comments pane's Send and a recording that carries comments. A media comment is
  /// "changed" only when the current version of its file is known (it was opened here) and differs from the drawn one.
  ({String text, List<ImageRef> images}) composeComments(
    String general,
    List<Comment> items,
    String lang, {
    List<ImageRef> own = const [],
  }) {
    final versions = fileVersions;
    return composeSend(
      general,
      items,
      feed,
      lang,
      own: own,
      staleOf: (c) => switch (c.anchor) {
        MediaAnchor(:final source, :final version?) when source.ref == null =>
          versions[source.path] != null && versions[source.path] != version,
        _ => false,
      },
    );
  }

  /// What a recording carries when it leaves, composed then and not at record time: only the [ids] still pending
  /// (the desktop may have sent or deleted some meanwhile), their batch and images. None for a window older than 16.
  ({String text, List<ImageRef> images, List<String> ids}) composeFor(
    List<String> ids,
    String lang,
  ) {
    final items = voiceCommentsProtocol
        ? comments.pendingOf(ids)
        : const <Comment>[];
    if (items.isEmpty) return (text: '', images: const [], ids: const []);
    final b = composeComments('', items, lang);
    return (text: b.text, images: b.images, ids: [for (final c in items) c.id]);
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

  /// An event of the window: the comments and the voice outbox take theirs, the state all.
  void _event(ServerEvent e) {
    switch (e) {
      case ServerEventReplay():
        _retrying.clear();
      case ServerEventHello(:final protocol):
        comments.hello(protocol);
      case ServerEventComments(:final items, :final ack):
        comments.apply(items, ack: ack);
      case ServerEventCommentAck(:final opId):
        comments.acked(opId);
      case ServerEventCommentRefused(:final opId, :final reason):
        comments.refused(opId, reason);
      case ServerEventSendRefused(:final id):
        _retrying.remove(id);
        voiceOutbox.refused(id);
      // a send-held is taken: it waits in [held] and comes back as a `user` event when it goes
      case ServerEventSendHeld(:final id) || ServerEventUser(:final id):
        _retrying.remove(id);
        voiceOutbox.arrived(id);
      default:
    }
    windowState.apply(e);
    switch (e) {
      // a window of protocol 27 may hold a message it never told this socket of (issue 499): judge once its
      // `compact-pending`, which follows the replay, says what it holds
      case ServerEventReplay():
        if (canOrderCompact) {
          _reconcileHeld = true;
        } else {
          _reconcile();
        }
      case ServerEventCompactPending():
        if (_reconcileHeld) _reconcile();
      default:
    }
  }

  bool _reconcileHeld = false;

  /// After a replay: what the window shows or holds has arrived; what was sent and is in neither was lost with the socket.
  void _reconcile() {
    _reconcileHeld = false;
    voiceOutbox.reconcile({
      for (final i in feed.items)
        if (i is UserItem) i.id,
      for (final h in held) h.id,
    });
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
