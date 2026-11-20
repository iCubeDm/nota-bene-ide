// What one window says of itself over its socket (issue 511): the feed, the agent's models, mode and effort, the held
// messages, a pending compaction or restart, the stats. [WindowState.apply] takes each event; the socket itself is
// [WindowConnection]'s.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../media/media_comment.dart' show WindowHttp;
import 'feed.dart';
import 'window_connection.dart' show uuidV4;

class WindowState extends ChangeNotifier {
  WindowState({
    required bool Function(ClientMessage) send,
    required WindowHttp? Function() http,
  }) : _send = send,
       _http = http;

  final bool Function(ClientMessage) _send;
  final WindowHttp? Function() _http;

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

  /// path → the ETag of the file as last read here (`/file`), to tell a media comment drawn on an earlier version
  final fileVersions = <String, String>{};
  Capabilities? capabilities;

  /// The temp folders whose images the window serves (`/tmpimage`), from its hello; none until then.
  List<String> tmpDirs = const [];

  /// What the phone learned of the window's Whisper since its hello: on once the phone turned it on, off after a 503
  /// to a clip's transcription or a voice message the window could not transcribe because Whisper is off; null until
  /// then, when the hello's capability holds.
  bool? whisperOn;
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

  /// When the last turn ended in this tab's sight (null after a fresh replay: the feed carries no times).
  DateTime? lastDoneAt;

  /// When the agent was first seen working in this run of work; null while it is not.
  DateTime? busySince;

  /// The clock of [lastDoneAt], [busySince] and the header's elapsed time; replaced in tests.
  DateTime Function() clock = DateTime.now;

  final _refusals = StreamController<ServerEventSendRefused>.broadcast();
  final _errors = StreamController<ServerEventServerError>.broadcast();

  /// A send the window refused (busy, switching): the composer keeps its text.
  Stream<ServerEventSendRefused> get refusals => _refusals.stream;

  Stream<ServerEventServerError> get errors => _errors.stream;

  bool get busy => feed.busy;

  bool _disposed = false;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// A new socket: what the last one said of a pending compaction, a restart and Whisper, the new one says again.
  void socket() {
    whisperOn = null;
    compactPending = restartPending = false;
    held = const [];
  }

  /// Takes event [e] of the window's socket.
  void apply(ServerEvent e) {
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
      case ServerEventHello(:final capabilities, :final tmpDirs):
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
      case ServerEventSendRefused():
        _refusals.add(e);
      case ServerEventCompactPending(:final pending, :final held):
        compactPending = pending;
        this.held = held;
      case ServerEventRestartPending(:final pending):
        restartPending = pending;
      case ServerEventVoiceText(:final error):
        // Whisper was switched off on the computer since the hello: the mic then offers to turn it on
        if (error == VoiceError.off) whisperOn = false;
        feed.apply(e);
      case ServerEventServerError():
        _errors.add(e);
      // the socket's and the comments' own: not the feed's
      case ServerEventOccupied() ||
          ServerEventComments() ||
          ServerEventCommentAck() ||
          ServerEventCommentRefused() ||
          ServerEventSendHeld():
        break;
      default:
        feed.apply(e);
    }
  }

  /// Asks for permission mode [m]; the shown [mode] changes when the server's `mode` event arrives. False when it did not go.
  bool setMode(AgentMode m) => _send(ClientMessageMode(mode: m, id: uuidV4()));

  /// Turns idle compaction on or off; the shown state follows at once, as the desktop's does. False when it did not go.
  bool toggleIdleCompact() {
    final st = idleCompact;
    if (st == null) return false;
    final sent = _send(ClientMessageIdleCompact(on: !st.on));
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

  bool _loadingEarlier = false;

  /// The next archived segment before the feed (the transcript before its compactions), as the desktop loads it.
  Future<void> loadEarlier() async {
    final http = _http(), session = feed.sessionId;
    if (_loadingEarlier ||
        http == null ||
        session == null ||
        feed.earlier == 0) {
      return;
    }
    _loadingEarlier = true;
    try {
      final segment = feed.earlier, epoch = feed.epoch;
      final r = await http(
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

  @override
  void dispose() {
    _disposed = true;
    _refusals.close();
    _errors.close();
    super.dispose();
  }
}
