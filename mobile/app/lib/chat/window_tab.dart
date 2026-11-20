// The phone as an ordinary tab of one window (/ws?tab=<id>), over a host link. The one-tab rule is the server's:
// occupied → Work here sends takeover; a 4001 means another tab took the window, and Work here takes it back. A
// window that went away (4904) is reopened when the host lists it again; a link that went down keeps the feed
// readable until the next replay replaces it.
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/comments.dart';
import '../comments/queue.dart';

import '../hosts/host_link.dart';
import '../media/fetch.dart';
import '../media/media_comment.dart' show WindowHttp;
import '../voice/outbox.dart';
import 'feed.dart';

enum TabState { connecting, open, occupied, taken, gone, offline }

const takenOverCode = 4001;

String uuidV4() {
  final r = Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

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
  WindowTab(this.link, HostWindow w, {Future<void> Function(Duration)? retry})
    : _key = w.key,
      root = w.root,
      _port = w.port,
      _retry = retry ?? ((d) => Future<void>.delayed(d)) {
    voiceOutbox.attach(
      this,
      send: send,
      http: () => http,
      compose: composeFor,
      canDetect: () => detectProtocolOk,
    );
    comments.held = () => voiceOutbox.heldIds;
    voiceOutbox.addListener(comments.refresh);
    link.addListener(_linkChanged);
    _linkChanged();
  }

  final HostLink link;

  /// The window's key on its host ([HostWindowKey.key]) as it was last listed.
  String get key => _key;
  String _key;
  final String root;
  int _port;

  /// The window as its host lists it now; null while it is not listed. The one on the tab's port first: a second
  /// window of the folder and agent on a lower port takes the bare id (issue 511), and the chat must not move to it.
  /// By key only once that port is gone (a restart on another port). The folder too: a host before ids keys by port.
  HostWindow? get window {
    final same = link.windows.where((w) => w.root == root);
    final w =
        same.where((w) => w.port == _port).firstOrNull ??
        same.where((w) => w.key == _key).firstOrNull;
    if (w != null) {
      _port = w.port;
      _key = w.key;
    }
    return w;
  }

  /// Transport only: where the window's streams open (the port it was last listed on).
  int get port {
    window;
    return _port;
  }

  final Future<void> Function(Duration) _retry;

  /// In memory only: a tab id kept on disk would let a second copy of the app steal the window.
  final String tabId = uuidV4();

  TabState _state = TabState.connecting;
  Feed feed = Feed();

  /// What of the feed is unfolded; it outlives the chat's widgets, as the desktop's `feedUi` does the feed's.
  final feedUi = FeedUi();
  List<ModelOption> models = const [];
  String? model;
  AgentEffort? effort;

  /// The window's permission mode, as the server last said it: its `mode` event goes to a tab the moment it attaches
  /// (server.ts, attachOwner, just before `models`), so a fresh tab has it without asking. The tab's own change shows
  /// only when that event comes back, with its `ack`.
  AgentMode? mode;
  num? protocol;

  /// What the app keeps for this window beyond the tab, by host and session (the project before the host lists one).
  late final String _box = '${link.host.id}|${window?.session ?? root}';

  /// The window's comments of this session (the server's set), with the changes made here it has not acked, which
  /// outlive the app.
  late final comments = Comments(
    send,
    () => feed.sessionId,
    queue: CommentQueues.instance.of(_box),
  );

  /// The voice messages recorded for this window that it has not shown yet. They belong to the app, by host and
  /// window, and outlive this tab: leaving the chat loses none.
  late final voiceOutbox = VoiceStore.instance.outbox(_box);

  /// The window's own requests through its channel; null while the host is offline.
  WindowHttp? get http {
    final ch = link.channel;
    if (ch == null) return null;
    return (method, path, {headers, body}) =>
        ch.http(port, method, path, headers: headers, body: body);
  }

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

  /// Whether the window can detect the spoken language (protocol 18); an older one gets the language alone.
  bool get detectProtocolOk => hasFeature(protocol, Feature.voiceDetect);

  /// Whether the window speaks protocol 14, where voice messages begin.
  bool get voiceProtocol => hasFeature(protocol, Feature.voice);

  /// Whether a voice message may carry the pending comments (protocol 16); an older window gets the recording alone.
  bool get voiceCommentsProtocol => hasFeature(protocol, Feature.voiceComments);

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

  /// path → the ETag of the file as last read here (`/file`), to tell a media comment drawn on an earlier version
  final fileVersions = <String, String>{};
  Capabilities? capabilities;

  /// The temp folders whose images the window serves (`/tmpimage`), from its hello; none until then.
  List<String> tmpDirs = const [];

  /// The attachments read for the feed's thumbnails and the viewer, by their request path, within a byte cap.
  final mediaCache = MediaCache();

  /// What the phone learned of the window's Whisper since its hello: on once the phone turned it on, off after a 503
  /// to a clip's transcription or a voice message the window could not transcribe because Whisper is off; null until
  /// then, when the hello's capability holds.
  bool? whisperOn;

  /// Whether the window transcribes the phone's recordings now.
  bool get whisper =>
      state == TabState.open &&
      (whisperOn ?? capabilities?.dictation == 'whisper');
  ServerEventStats? stats;

  /// The server's idle-compaction state of this project (`idle-compact` event); null until it says.
  IdleCompact? idleCompact;

  /// Protocol 27 (issue 499): a compaction waits for the agent's next pause (`compact-pending`).
  bool compactPending = false;

  /// The messages the window holds behind a pending restart or compaction, oldest first; they go after it.
  List<HeldSend> held = const [];

  /// A server restart waits for the agent's next pause (`restart-pending`, protocol 22): the held messages wait for it first.
  bool restartPending = false;

  /// A compaction is pending or messages are held: a /clear would run ahead of them, so it waits like one while busy.
  bool get orderWaits => compactPending || held.isNotEmpty;

  /// Whether the window orders a Compact while the agent works for its next pause (protocol 27).
  bool get canOrderCompact => hasFeature(protocol, Feature.compactOrder);

  /// When the last turn ended in this tab's sight (null after a fresh replay: the feed carries no times).
  DateTime? lastDoneAt;

  /// When the agent was first seen working in this run of work; null while it is not.
  DateTime? busySince;

  /// The clock of [lastDoneAt], [busySince] and the header's elapsed time; replaced in tests.
  DateTime Function() clock = DateTime.now;

  final _refusals = StreamController<ServerEventSendRefused>.broadcast();
  final _errors = StreamController<ServerEventServerError>.broadcast();

  MuxStream? _stream;
  Channel? _on;
  bool _passive = false;
  bool _takeoverWanted = false;
  bool _reopening = false;
  List<HostWindow>? _goneList;
  bool _disposed = false;

  TabState get state => _state;

  /// A send the window refused (busy, switching): the composer keeps its text.
  Stream<ServerEventSendRefused> get refusals => _refusals.stream;

  Stream<ServerEventServerError> get errors => _errors.stream;

  bool get busy => feed.busy;

  void _set(TabState s) {
    if (_state == s) return;
    _state = s;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _linkChanged() {
    if (_disposed) return;
    final ch = link.channel;
    if (link.state != LinkState.online || ch == null) {
      if (_state != TabState.taken) _set(TabState.offline);
      return;
    }
    if (_state == TabState.gone) {
      // only a list the host sent after the close: the one from before still names the window that just went
      final fresh = !identical(link.windows, _goneList);
      if (fresh && window != null) {
        _open(ch);
      }
      return;
    }
    if (!identical(ch, _on) &&
        _state != TabState.taken &&
        _state != TabState.gone) {
      _open(ch);
    }
  }

  void _open(Channel ch) {
    _stream?.close(1000);
    // a new socket: the comment queue waits for its hello (issue 494)
    comments.closed();
    _on = ch;
    whisperOn = null;
    compactPending = restartPending = false; // the new socket says again
    held = const [];
    final s = _stream = ch.ws(
      port,
      // held=1 (issue 499): the phone knows `send-held`, so its messages may wait behind a pending restart or compaction
      '/ws?tab=$tabId&held=1${_passive ? '&passive=1' : ''}',
    );
    _set(TabState.connecting);
    s.messages.listen((m) {
      if (m.binary || !identical(s, _stream)) return;
      final Object? j;
      try {
        j = jsonDecode(utf8.decode(m.data));
      } on FormatException {
        return;
      }
      if (j is Map) _event(ServerEvent.fromJson(j.cast<String, Object?>()));
    });
    s.closed.then((c) {
      if (!identical(s, _stream) || _disposed) return;
      _stream = null;
      _closed(c.code);
    });
  }

  void _closed(int code) {
    if (code == takenOverCode) {
      _passive = true;
      _set(TabState.taken);
      return;
    }
    if (code == unknownWindow) {
      _goneList = link.windows;
      _set(TabState.gone);
      return;
    }
    if (link.state != LinkState.online ||
        link.channel == null ||
        link.channel!.isClosed) {
      _set(TabState.offline);
      return;
    }
    // the window's socket closed under a live link (a restart, a refused socket): try again in a second, as the web does
    _set(TabState.connecting);
    if (_reopening) return;
    _reopening = true;
    _retry(const Duration(seconds: 1)).then((_) {
      _reopening = false;
      final ch = link.channel;
      if (!_disposed &&
          _stream == null &&
          ch != null &&
          _state == TabState.connecting) {
        _open(ch);
      }
    });
  }

  void _event(ServerEvent e) {
    final wasBusy = feed.busy;
    _apply(e);
    if (feed.busy && !wasBusy) busySince = clock();
    if (!feed.busy) busySince = null;
    if (wasBusy &&
        !feed.busy &&
        e is ServerEventAgent &&
        e.e is WireAgentEventTurnEnd) {
      lastDoneAt = clock();
    }
    _notify();
  }

  void _apply(ServerEvent e) {
    switch (e) {
      case ServerEventReplay():
        _retrying.clear();
        _takeoverWanted = false;
        _passive = false;
        feed.apply(e);
        // a window of protocol 27 may hold a message it never told this socket of (issue 499): judge once its
        // `compact-pending`, which follows the replay, says what it holds
        if (canOrderCompact) {
          _reconcileHeld = true;
        } else {
          _reconcile();
        }
        _set(TabState.open);
        // what waited for the window goes on now that it takes messages
        voiceOutbox.opened();
        comments.flush();
      case ServerEventOccupied():
        _passive = true;
        if (_takeoverWanted) {
          _raw(const ClientMessageTakeover());
        } else {
          _set(TabState.occupied);
        }
      case ServerEventHello(
        :final protocol,
        :final capabilities,
        :final tmpDirs,
      ):
        this.protocol = protocol;
        comments.hello(protocol);
        this.capabilities = capabilities;
        this.tmpDirs = [
          for (final d in tmpDirs ?? const <String>[])
            if (d.startsWith('/') && d.length > 1)
              d.replaceAll(RegExp(r'/+$'), ''),
        ];
        whisperOn = null;
      case ServerEventModels(:final models):
        this.models = models;
      case ServerEventMode(:final mode):
        this.mode = mode;
      case ServerEventModel(:final model, :final effort):
        this.model = model;
        this.effort = effort;
      case ServerEventStats():
        stats = e;
      case ServerEventIdleCompact(:final state):
        idleCompact = state;
      case ServerEventComments(:final items, :final ack):
        comments.apply(items, ack: ack);
      case ServerEventCommentAck(:final opId):
        comments.acked(opId);
      case ServerEventCommentRefused(:final opId, :final reason):
        comments.refused(opId, reason);
      case ServerEventSendRefused(:final id):
        _retrying.remove(id);
        voiceOutbox.refused(id);
        _refusals.add(e);
      case ServerEventCompactPending(:final pending, :final held):
        compactPending = pending;
        this.held = held;
        if (_reconcileHeld) _reconcile();
      case ServerEventRestartPending(:final pending):
        restartPending = pending;
      case ServerEventSendHeld(:final id):
        // taken: it waits in [held] and comes back as a `user` event when it goes
        _retrying.remove(id);
        voiceOutbox.arrived(id);
      case ServerEventUser(:final id):
        _retrying.remove(id);
        voiceOutbox.arrived(id);
        feed.apply(e);
      case ServerEventVoiceText(:final error):
        // Whisper was switched off on the computer since the hello: the mic then offers to turn it on
        if (error == VoiceError.off) whisperOn = false;
        feed.apply(e);
      case ServerEventServerError():
        _errors.add(e);
      default:
        feed.apply(e);
    }
  }

  bool _raw(ClientMessage m) {
    final s = _stream;
    if (s == null || s.isClosed) return false;
    s.send(utf8.encode(jsonEncode(m.toJson()))).catchError((_) {});
    return true;
  }

  /// Sends [m] when the tab owns the window (anything else would be dropped by the server); false when it did not go.
  bool send(ClientMessage m) => _state == TabState.open && _raw(m);

  /// Asks for permission mode [m]; the shown [mode] changes when the server's `mode` event arrives. False when it did not go.
  bool setMode(AgentMode m) => send(ClientMessageMode(mode: m, id: uuidV4()));

  /// Turns idle compaction on or off; the shown state follows at once, as the desktop's does. False when it did not go.
  bool toggleIdleCompact() {
    final st = idleCompact;
    if (st == null) return false;
    final sent = send(ClientMessageIdleCompact(on: !st.on));
    if (sent) {
      idleCompact = IdleCompact(
        on: !st.on,
        blocked: st.blocked,
        minutes: st.minutes,
        awayMinutes: st.awayMinutes,
        minTokens: st.minTokens,
      );
      _notify();
    }
    return sent;
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

  bool _loadingEarlier = false;

  /// The next archived segment before the feed (the transcript before its compactions), as the desktop loads it.
  Future<void> loadEarlier() async {
    final ch = link.channel, session = feed.sessionId;
    if (_loadingEarlier || ch == null || session == null || feed.earlier == 0) {
      return;
    }
    _loadingEarlier = true;
    try {
      final segment = feed.earlier, epoch = feed.epoch;
      final r = await ch.http(
        port,
        'GET',
        '/history?session=${Uri.encodeQueryComponent(session)}&before=${segment + 1}',
      );
      if (r.status != 200 || feed.sessionId != session) return;
      final j = jsonDecode(utf8.decode(r.body)) as Map<String, Object?>;
      feed.prepend(
        [
          for (final e in j['events'] as List)
            ServerEvent.fromJson((e as Map).cast<String, Object?>()),
        ],
        segment: (j['segment'] as num).toInt(),
        more: j['more'] == true,
        epoch: epoch,
      );
      _notify();
    } on Object {
      // the channel went or the page was not readable: the button stays for another try
    } finally {
      _loadingEarlier = false;
    }
  }

  /// Opens the window's socket again by hand, for a window that went and has not come back on its own. The phone cannot
  /// start a window (the protocol has no such request), so this is only another try at reaching it.
  void reopen() {
    final ch = link.channel;
    if (_state != TabState.gone ||
        ch == null ||
        link.state != LinkState.online) {
      return;
    }
    _open(ch);
  }

  /// Work here: from occupied, at once; from taken, on a new socket whose occupied is answered with takeover.
  void takeOver() {
    _takeoverWanted = true;
    if (_state == TabState.occupied) {
      _raw(const ClientMessageTakeover());
    } else if (_state == TabState.taken) {
      final ch = link.channel;
      if (ch != null && link.state == LinkState.online) _open(ch);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    link.removeListener(_linkChanged);
    _stream?.close(1000);
    _refusals.close();
    _errors.close();
    voiceOutbox.removeListener(comments.refresh);
    voiceOutbox.detach(this);
    super.dispose();
  }
}
