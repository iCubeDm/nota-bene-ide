// A project's sound embedded in a reply as an image (`![](clips/take.mp3)`, as the desktop shows it with its player):
// a row with play/pause, the file's name and, once it has played, its position and length. The file is read from the
// window (`/file`) into the cache when it starts, so a file the agent rewrote plays as it is now, and plays through
// the voice messages' player: one sound at a time.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import 'agent_connection.dart' show AgentConnection;
import '../media/fetch.dart';
import '../theme.dart';
import '../usage/format.dart' show byteSize;
import '../ui/nb_icon.dart';
import '../voice/player.dart';
import '../voice/voice_view.dart' show clock;
import 'embed.dart';
import 'paths.dart';
import 'window_tab.dart';

export 'paths.dart' show soundPath;

/// The largest sound the phone reads.
const soundMaxBytes = 64000000;

typedef Written = ({String? path, FetchFail? fail});

/// Where a sound read from the window is written before it plays.
abstract class ClipFiles {
  /// The app's; a test puts its own.
  static ClipFiles shared = DiskClipFiles();

  /// [body] written as the file [name]: its path, or why there is none (past [max] bytes, short of a known [length],
  /// broken off, or [abandoned] first). Without a path nothing is left behind and the body is no longer read.
  Future<Written> write(
    String name,
    Stream<List<int>> body, {
    required int max,
    int? length,
    Future<void>? abandoned,
  });
}

/// In the cache folder of the voice messages (the platform clears it when it needs room); a sound read again replaces
/// its file.
class DiskClipFiles implements ClipFiles {
  static var _seq = 0;

  @override
  Future<Written> write(
    String name,
    Stream<List<int>> body, {
    required int max,
    int? length,
    Future<void>? abandoned,
  }) async {
    File? part;
    try {
      final dir = await playChannel.invokeMethod<String>('dir');
      final f = File('$dir/clips/$name');
      await f.parent.create(recursive: true);
      // written aside, under a name of this read alone, and renamed: a half-written file is never taken for the sound,
      // and two reads of one sound do not write into each other (issue 452)
      part = File('${f.path}.$pid-${++_seq}.part');
      final sink = part.openWrite();
      final end = Completer<FetchFail?>();
      var n = 0;
      late final StreamSubscription<List<int>> sub;
      void finish(FetchFail? fail) {
        if (end.isCompleted) return;
        if (fail != null) unawaited(sub.cancel());
        end.complete(fail);
      }

      sub = body.listen(
        (c) {
          n += c.length;
          if (n > max) return finish(FetchFail.tooLarge);
          sink.add(c);
        },
        onError: (Object _) => finish(FetchFail.unreadable),
        onDone: () =>
            finish(length != null && n != length ? FetchFail.unreadable : null),
        cancelOnError: true,
      );
      abandoned?.then((_) => finish(FetchFail.unreadable));
      var fail = await end.future;
      try {
        await sink.close();
      } on Object {
        fail ??= FetchFail.unreadable;
      }
      if (fail != null) {
        await _drop(part);
        return (path: null, fail: fail);
      }
      await part.rename(f.path);
      return (path: f.path, fail: null);
    } on Object {
      if (part != null) await _drop(part);
      return (path: null, fail: FetchFail.unreadable);
    }
  }

  static Future<void> _drop(File f) async {
    try {
      if (await f.exists()) await f.delete();
    } on Object {
      // the cache is the platform's to clear
    }
  }
}

/// A short stable name of [key] (FNV-1a), for the file of a sound.
String _hash(String key) {
  var h = 0x811c9dc5;
  for (final u in key.codeUnits) {
    h = ((h ^ u) * 0x01000193) & 0xffffffff;
  }
  return h.toRadixString(16).padLeft(8, '0');
}

/// [rel] of [tab]'s project read into a file of [files]: its path, or why there is none. Never throws. Once
/// [abandoned] completes the read stops and gives nothing.
/// A clip's identity: its host, its window (by key: two agents of one server share a port, epic 383) and its path.
String clipKey(AgentConnection c, String rel) =>
    '${c.link.host.id}|${c.key}|$rel';

Future<Written> fetchSound(
  WindowTab tab,
  String rel, {
  ClipFiles? files,
  Future<void>? abandoned,
}) async {
  Written failed(FetchFail f) => (path: null, fail: f);
  var gone = false;
  abandoned?.then((_) => gone = true);
  final ch = tab.connection.link.channel;
  if (ch == null) return failed(FetchFail.unreadable);
  try {
    final a = tab.connection.address;
    final r = await ch.httpStream(
      a.port,
      'GET',
      a.at('/file?path=${Uri.encodeQueryComponent(rel)}'),
    );
    final bad = fetchFailOf(r.status);
    final length = int.tryParse(r.headers['content-length'] ?? '');
    if (gone || bad != null || (length != null && length > soundMaxBytes)) {
      r.cancel();
      return failed(bad ?? FetchFail.tooLarge);
    }
    final ext = soundPath.firstMatch(rel)![0]!.toLowerCase();
    final name = '${_hash(clipKey(tab.connection, rel))}$ext';
    final got = await (files ?? ClipFiles.shared).write(
      name,
      r.body,
      max: soundMaxBytes,
      length: length,
      abandoned: abandoned,
    );
    if (got.path == null) r.cancel();
    return got;
  } on Object {
    return failed(FetchFail.unreadable);
  }
}

class AudioClip extends StatefulWidget {
  const AudioClip(this.src, {super.key, this.player});

  /// The path as the reply wrote it: relative to the project's root, or absolute inside it.
  final String src;
  final VoicePlayer? player;

  @override
  State<AudioClip> createState() => _AudioClipState();
}

class _AudioClipState extends State<AudioClip> {
  FetchFail? _fail;

  // why the last read of the file gave none
  FetchFail? _readFail;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final p = widget.player ?? VoicePlayer.shared;
    final (:tab, :rel) = embedTarget(context, widget.src);
    final shownName = embedName(widget.src);
    final id = tab == null || rel == null
        ? null
        : 'clip|${clipKey(tab.connection, rel)}';
    Future<String?> open(Future<void> abandoned) async {
      final got = await fetchSound(tab!, rel!, abandoned: abandoned);
      _readFail = got.fail;
      return got.path;
    }

    // what the start says, and only that: a start left for another sound has nothing to say (issue 452)
    void ended(SoundStart s) {
      if (!mounted) return;
      final fail = switch (s) {
        SoundStart.noFile => _readFail ?? FetchFail.unreadable,
        SoundStart.unplayable => FetchFail.unreadable,
        SoundStart.playing => null,
        _ => _fail,
      };
      if (fail != _fail) setState(() => _fail = fail);
    }

    Future<void> toggle() async => ended(await p.toggleSound(id!, open));

    return ListenableBuilder(
      listenable: p,
      builder: (context, _) {
        final mine = id != null && p.isCurrent(id);
        final playing = mine && p.playing;
        final length = id == null ? null : p.lengthOf(id);
        final time = mine
            ? (length == null
                  ? clock(p.position)
                  : '${clock(p.position)} / ${clock(length)}')
            : (length == null ? null : clock(length));
        final done = !mine || length == null || length.inMilliseconds <= 0
            ? 0.0
            : (p.position.inMilliseconds / length.inMilliseconds).clamp(
                0.0,
                1.0,
              );
        const barWidth = 160.0;
        Future<void> seekTo(double dx) async => ended(
          await p.seekSound(
            id!,
            open,
            Duration(
              milliseconds:
                  (length!.inMilliseconds * (dx / barWidth).clamp(0, 1))
                      .round(),
            ),
          ),
        );
        final fail = rel == null && tab != null ? FetchFail.outside : _fail;
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: playing ? t.voicePause : t.voicePlay,
                onPressed: id == null ? null : toggle,
                style: IconButton.styleFrom(
                  fixedSize: const Size.square(40),
                  backgroundColor: c.primary,
                  foregroundColor: c.primaryFg,
                ),
                icon: mine && p.loading
                    ? SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: c.primaryFg,
                        ),
                      )
                    : NbIcon(playing ? NbGlyph.pause : NbGlyph.play),
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      shownName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: c.foreground, fontSize: 13),
                    ),
                    if (mine && length != null)
                      GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTapUp: (d) => seekTo(d.localPosition.dx),
                        onHorizontalDragUpdate: (d) =>
                            seekTo(d.localPosition.dx),
                        child: SizedBox(
                          width: barWidth,
                          height: 16,
                          child: Center(
                            child: LinearProgressIndicator(
                              value: done,
                              minHeight: 3,
                              color: c.primary,
                              backgroundColor: c.mutedFg.withValues(alpha: .3),
                            ),
                          ),
                        ),
                      ),
                    if (fail != null)
                      Text(switch (fail) {
                        FetchFail.notFound => t.fileNotFound,
                        FetchFail.outside => t.fileOutside,
                        FetchFail.tooLarge => t.soundTooLarge(
                          byteSize(
                            soundMaxBytes,
                            Localizations.localeOf(context).languageCode,
                          ),
                        ),
                        FetchFail.unreadable => t.soundUnplayable,
                      }, style: TextStyle(color: c.mutedFg, fontSize: 12))
                    else if (time != null)
                      Text(
                        time,
                        style: TextStyle(
                          color: c.mutedFg,
                          fontSize: 12,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
