// The voice messages the phone has recorded and the window has not shown yet: each is uploaded, then sent, and stays
// as a bubble of its own (Sending…) until the window's `user` event for it comes. A failure leaves the bubble with
// Retry (and Delete): a recording is never lost silently. The outboxes belong to the app, not to the chat route: one
// per window, kept on disk (the WAV and a small index), so leaving the chat or the app dying changes nothing; the next
// open of the window shows what is left and goes on with it.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart' show uuidV4;
import '../media/media_comment.dart';
import 'player.dart';
import 'upload.dart';
import 'wav.dart';

/// What a recording carries when it leaves: the ids still pending, their batch text and images.
typedef ComposeFor =
    ({String text, List<ImageRef> images, List<String> ids}) Function(
      List<String> ids,
      String lang,
    );

/// [uploading]: not yet on the host, or on it and not yet sent (a send waits for a window that is there).
enum OutStage { uploading, sent, failed }

class PendingVoice {
  PendingVoice(
    this.key,
    this.lang,
    this.ms,
    this.wave, {
    this.wav,
    this.commentIds = const [],
    this.commentLang = 'en',
    this.detect = false,
  }) : id = uuidV4();

  PendingVoice.fromJson(Map<String, Object?> j)
    : key = j['key']! as String,
      lang = j['lang']! as String,
      ms = (j['ms']! as num).toInt(),
      wave = (j['wave']! as List).cast<num>(),
      id = j['id']! as String,
      commentIds = ((j['commentIds'] as List?) ?? const []).cast<String>(),
      commentLang = (j['commentLang'] as String?) ?? 'en',
      detect = j['detect'] == true,
      voice = j['voice'] == null
          ? null
          : Voice.fromJson((j['voice']! as Map).cast<String, Object?>()),
      stage = OutStage.values.byName(j['stage']! as String);

  /// What the player, the feed and the file on disk know it by (a fresh uuid, never reused).
  final String key;
  final String lang;

  /// Recorded under Automatic: [lang] is the hint, and a host that can (protocol 18) detects the language.
  final bool detect;
  final int ms;
  List<num> wave;

  /// In memory until it is on the host; after that the disk has it.
  Uint8List? wav;

  /// The pending comments riding along (protocol 16): their ids and the language of their batch, which is written
  /// when the recording leaves (what is still pending then), with the images that go along.
  List<String> commentIds;
  final String commentLang;
  String text = '';
  List<ImageRef> images = const [];

  /// The host's copy, once uploaded.
  Voice? voice;

  /// The id of the current attempt's `send`.
  String id;

  /// "Send now": the first attempt interrupts the agent. Not kept on disk and cleared by a retry, which goes after.
  bool force = false;
  OutStage stage = OutStage.uploading;
  bool _running = false;
  Timer? _timer;

  Map<String, Object?> toJson() => {
    'key': key,
    'lang': lang,
    if (detect) 'detect': true,
    'ms': ms,
    'wave': wave,
    'id': id,
    if (commentIds.isNotEmpty) ...{
      'commentIds': commentIds,
      'commentLang': commentLang,
    },
    'voice': ?voice?.toJson(),
    'stage': stage.name,
  };
}

/// Where the outboxes keep their files; the app's files dir on the phone.
abstract class OutFiles {
  Future<String?> readIndex();
  Future<void> writeIndex(String json);
  Future<void> writeWav(String name, Uint8List bytes);
  Future<Uint8List?> readWav(String name);
  Future<void> deleteWav(String name);
}

/// `filesDir/voice-out` (`nb/play`'s `outDir`); where the platform has none (tests), nothing is kept.
class DiskOutFiles implements OutFiles {
  Future<Directory?> _dir() async {
    try {
      final p = await playChannel.invokeMethod<String>('outDir');
      return p == null ? null : Directory(p);
    } on Object {
      return null;
    }
  }

  @override
  Future<String?> readIndex() async {
    final d = await _dir();
    final f = d == null ? null : File('${d.path}/index.json');
    return f != null && await f.exists() ? f.readAsString() : null;
  }

  @override
  Future<void> writeIndex(String json) async {
    final d = await _dir();
    if (d == null) return;
    final part = File('${d.path}/index.json.part');
    await part.writeAsString(json, flush: true);
    await part.rename('${d.path}/index.json');
  }

  @override
  Future<void> writeWav(String name, Uint8List bytes) async {
    final d = await _dir();
    if (d != null) {
      await File('${d.path}/$name.wav').writeAsBytes(bytes, flush: true);
    }
  }

  @override
  Future<Uint8List?> readWav(String name) async {
    final d = await _dir();
    final f = d == null ? null : File('${d.path}/$name.wav');
    return f != null && await f.exists() ? f.readAsBytes() : null;
  }

  @override
  Future<void> deleteWav(String name) async {
    final d = await _dir();
    final f = d == null ? null : File('${d.path}/$name.wav');
    if (f != null && await f.exists()) await f.delete();
  }
}

/// All the outboxes of the app, by window (host and session).
class VoiceStore {
  VoiceStore(this.files) {
    ready = _load();
  }

  /// The one the app uses; tests put their own.
  static VoiceStore instance = VoiceStore(DiskOutFiles());

  final OutFiles files;
  late final Future<void> ready;
  bool _loaded = false;
  final _boxes = <String, VoiceOutbox>{};
  final _onDisk = <String, List<PendingVoice>>{};
  Future<void> _writes = Future.value();

  Future<void> _load() async {
    try {
      final s = await files.readIndex();
      if (s != null) {
        for (final e in (jsonDecode(s)['entries'] as List)) {
          final m = (e as Map).cast<String, Object?>();
          (_onDisk[m['box']! as String] ??= []).add(PendingVoice.fromJson(m));
        }
      }
    } on Object {
      // an unreadable index: start empty (the WAVs stay on disk)
    }
    _loaded = true;
    for (final b in _boxes.values) {
      b._adopt(_onDisk.remove(b.key) ?? const []);
    }
  }

  VoiceOutbox outbox(String key) {
    final b = _boxes[key];
    if (b != null) return b;
    final n = _boxes[key] = VoiceOutbox._(key, this);
    if (_loaded) n._adopt(_onDisk.remove(key) ?? const []);
    return n;
  }

  /// Writes the index: every entry of every window, one write after another.
  void save() {
    final all = <Map<String, Object?>>[
      for (final b in _boxes.values)
        for (final e in b.entries) {'box': b.key, ...e.toJson()},
      for (final MapEntry(:key, :value) in _onDisk.entries)
        for (final e in value) {'box': key, ...e.toJson()},
    ];
    final json = jsonEncode({'entries': all});
    _writes = _writes
        .then((_) => files.writeIndex(json))
        .catchError((Object _) {});
  }
}

class VoiceOutbox extends ChangeNotifier {
  VoiceOutbox._(this.key, this._store);

  final String key;
  final VoiceStore _store;
  final entries = <PendingVoice>[];

  /// How long a sent message may wait for the window to show it.
  static Duration sentTimeout = const Duration(seconds: 30);

  Object? _owner;
  bool Function(ClientMessage)? _send;
  WindowHttp? Function()? _http;
  ComposeFor? _compose;
  bool Function()? _canDetect;
  bool _disposed = false;

  void _adopt(List<PendingVoice> found) {
    if (found.isEmpty) return;
    entries.insertAll(0, found);
    _changed();
  }

  /// The chat showing this window: it sends through [send] and reaches the window through [http].
  void attach(
    Object owner, {
    required bool Function(ClientMessage) send,
    required WindowHttp? Function() http,
    ComposeFor? compose,
    bool Function()? canDetect,
  }) {
    _canDetect = canDetect;
    _owner = owner;
    _send = send;
    _http = http;
    _compose = compose;
  }

  void detach(Object owner) {
    if (!identical(_owner, owner)) return;
    _owner = _send = _http = _compose = _canDetect = null;
    for (final e in entries) {
      e._timer?.cancel();
      e._timer = null;
    }
  }

  /// The window is open (a replay came): what waits for it goes on.
  void opened() {
    for (final e in [...entries]) {
      if (e.stage == OutStage.uploading) _run(e);
    }
  }

  /// The ids the entries still hold (their comments are not offered again until the entry is over: arrived, deleted
  /// or, after a failure, retried). They survive a restart with the entries.
  Set<String> get heldIds => {for (final e in entries) ...e.commentIds};

  /// Uploads and sends [wav]; the bubble shows meanwhile. [commentIds] ride along: their batch is written when the
  /// message leaves, in [commentLang].
  void submit(
    Uint8List wav,
    String lang, {
    bool force = false,
    List<String> commentIds = const [],
    String commentLang = 'en',
    bool detect = false,
  }) {
    final e = PendingVoice(
      uuidV4(),
      lang,
      wavMs(wav),
      waveOf(wav),
      wav: wav,
      commentIds: commentIds,
      commentLang: commentLang,
      detect: detect,
    )..force = force;
    entries.add(e);
    _changed();
    unawaited(_start(e));
  }

  Future<void> _start(PendingVoice e) async {
    // on disk before anything can go wrong; the upload does not wait for the disk to fail
    try {
      await _store.files.writeWav(e.key, e.wav!);
    } on Object {
      // kept in memory only
    }
    await _run(e);
  }

  Future<Uint8List?> bytes(PendingVoice e) async =>
      e.wav ?? await _store.files.readWav(e.key);

  Future<void> _run(PendingVoice e) async {
    if (e._running || !entries.contains(e)) return;
    e._running = true;
    try {
      e.stage = OutStage.uploading;
      if (e.voice == null) {
        final http = _http?.call();
        // no chat to reach the window through: it goes on at the next open
        if (_owner == null) return;
        if (http == null) return _fail(e);
        final wav = await bytes(e);
        if (wav == null) return _fail(e);
        try {
          final v = await uploadVoice(http, wav);
          e.voice = v;
          e.wave = v.wave;
          // the recording is cached under the host's id: playing it needs no download
          unawaited(
            VoicePlayer.shared.files
                .save(v.id, wav)
                .then<void>((_) {})
                .catchError((Object _) {}),
          );
        } on VoiceUploadError {
          return _fail(e);
        }
        e.wav = null;
        _changed();
      }
      if (!entries.contains(e)) return;
      final send = _send;
      if (send == null) return;
      if (e.commentIds.isNotEmpty) {
        // now, not at record time: what is still pending (and the window's protocol) decides what rides along
        final c = _compose?.call(e.commentIds, e.commentLang);
        if (c == null) return _fail(e);
        e.commentIds = c.ids;
        e.text = c.text;
        e.images = c.images;
      }
      final sent = send(
        ClientMessageSend(
          id: e.id,
          text: e.text,
          voice: e.voice,
          lang: e.lang,
          detect: e.detect && (_canDetect?.call() ?? false) ? true : null,
          force: e.force ? true : null,
          commentIds: e.commentIds.isEmpty ? null : e.commentIds,
          images: e.images.isEmpty ? null : e.images,
        ),
      );
      if (sent) {
        e.stage = OutStage.sent;
        e._timer?.cancel();
        e._timer = Timer(sentTimeout, () => _fail(e));
        _changed();
      } else {
        _fail(e);
      }
    } finally {
      e._running = false;
    }
  }

  void _fail(PendingVoice e) {
    if (!entries.contains(e)) return;
    e._timer?.cancel();
    e.stage = OutStage.failed;
    _changed();
  }

  void retry(PendingVoice e) {
    if (e.stage != OutStage.failed) return;
    // a new id: the window may have seen the old one
    e.id = uuidV4();
    e.force = false;
    e.stage = OutStage.uploading;
    _changed();
    unawaited(_run(e));
  }

  void remove(PendingVoice e) {
    if (!entries.remove(e)) return;
    _forget(e);
    _changed();
  }

  /// The entry is over: its files go, and the player lets go of its bubble's voice.
  void _forget(PendingVoice e) {
    e._timer?.cancel();
    unawaited(_store.files.deleteWav(e.key).catchError((Object _) {}));
    unawaited(VoicePlayer.shared.drop(e.key));
  }

  /// The window showed message [id]: its bubble replaces ours.
  void arrived(String id) {
    final gone = entries.where((e) => e.stage == OutStage.sent && e.id == id);
    if (gone.isEmpty) return;
    for (final e in [...gone]) {
      entries.remove(e);
      _forget(e);
    }
    _changed();
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
        _forget(e);
      } else {
        _fail(e);
      }
    }
    _changed();
  }

  void _changed() {
    if (_disposed) return;
    _store.save();
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
