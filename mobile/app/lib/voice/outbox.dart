// The voice messages the phone has recorded and the window has not shown yet: each is uploaded, then sent, and stays
// as a bubble of its own (Sending…) until the window's `user` event for it comes. A failure leaves the bubble with
// Retry (and Delete): a recording is never lost silently.

import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart' show uuidV4;
import '../media/media_comment.dart';
import 'upload.dart';
import 'wav.dart';

enum OutStage { uploading, sent, failed }

class PendingVoice {
  PendingVoice(this.key, this.wav, this.lang)
    : ms = wavMs(wav),
      wave = waveOf(wav);

  /// What the player and the feed know the bubble by, for as long as it lives.
  final String key;
  final Uint8List wav;
  final String lang;
  final int ms;
  List<num> wave;

  /// The host's copy, once uploaded.
  Voice? voice;

  /// The id of the current attempt's `send`.
  String id = uuidV4();
  OutStage stage = OutStage.uploading;
}

class VoiceOutbox extends ChangeNotifier {
  VoiceOutbox(this._send, this._http);

  final bool Function(ClientMessage) _send;
  final WindowHttp? Function() _http;
  final entries = <PendingVoice>[];
  int _n = 0;
  bool _disposed = false;

  /// Uploads and sends [wav]; the bubble shows meanwhile.
  void submit(Uint8List wav, String lang) {
    final e = PendingVoice('pending:${_n++}', wav, lang);
    entries.add(e);
    notifyListeners();
    _run(e);
  }

  Future<void> _run(PendingVoice e) async {
    e.stage = OutStage.uploading;
    if (e.voice == null) {
      final http = _http();
      try {
        if (http == null) throw VoiceUploadError('offline');
        final v = await uploadVoice(http, e.wav);
        e.voice = v;
        e.wave = v.wave;
      } on VoiceUploadError {
        return _fail(e);
      }
    }
    if (!entries.contains(e)) return;
    final sent = _send(
      ClientMessageSend(id: e.id, text: '', voice: e.voice, lang: e.lang),
    );
    if (sent) {
      e.stage = OutStage.sent;
      _changed();
    } else {
      _fail(e);
    }
  }

  void _fail(PendingVoice e) {
    if (!entries.contains(e)) return;
    e.stage = OutStage.failed;
    _changed();
  }

  void retry(PendingVoice e) {
    if (e.stage != OutStage.failed) return;
    // a new id: the window may have seen the old one
    e.id = uuidV4();
    e.stage = OutStage.uploading;
    notifyListeners();
    _run(e);
  }

  void remove(PendingVoice e) {
    if (entries.remove(e)) notifyListeners();
  }

  /// The window showed message [id]: its bubble replaces ours.
  void arrived(String id) {
    final before = entries.length;
    entries.removeWhere((e) => e.stage == OutStage.sent && e.id == id);
    if (entries.length != before) notifyListeners();
  }

  /// The window refused message [id] (busy, switching).
  void refused(String id) {
    for (final e in entries) {
      if (e.id == id && e.stage == OutStage.sent) _fail(e);
    }
  }

  /// After a replay: what it shows has arrived; what was sent and is not in it was lost with the socket.
  void reconcile(Set<String> shown) {
    for (final e in [...entries]) {
      if (e.stage != OutStage.sent) continue;
      if (shown.contains(e.id)) {
        entries.remove(e);
      } else {
        e.stage = OutStage.failed;
      }
    }
    notifyListeners();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
