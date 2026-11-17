// A project's sound embedded in a reply as an image (`![](clips/take.mp3)`, as the desktop shows it with its player):
// a row with play/pause, the file's name and, once it has played, its position and length. The file is read from the
// window (`/file`) into the cache when it starts, so a file the agent rewrote plays as it is now, and plays through
// the voice messages' player: one sound at a time.
import 'dart:io';

import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../media/fetch.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../voice/player.dart';
import '../voice/voice_view.dart' show clock;
import 'files.dart';
import 'window_tab.dart';

/// The sounds a reply embeds (the desktop's own list, `AUDIO` of shared/src/cutCheck.ts).
final soundPath = RegExp(r'\.(mp3|wav|m4a|ogg)$', caseSensitive: false);

/// The largest sound the phone reads.
const soundMaxBytes = 64 * 1024 * 1024;

/// Where a sound read from the window is written before it plays.
abstract class ClipFiles {
  /// The app's; a test puts its own.
  static ClipFiles shared = DiskClipFiles();

  /// [body] written as the file [name]: its path, or null when it passes [max] bytes (nothing is left behind then).
  Future<String?> write(String name, Stream<List<int>> body, int max);
}

/// In the cache folder of the voice messages (the platform clears it when it needs room); a sound read again replaces
/// its file.
class DiskClipFiles implements ClipFiles {
  @override
  Future<String?> write(String name, Stream<List<int>> body, int max) async {
    final dir = await playChannel.invokeMethod<String>('dir');
    final f = File('$dir/clips/$name');
    await f.parent.create(recursive: true);
    // written aside and renamed: a half-written file must never be taken for the sound
    final part = File('${f.path}.part');
    final sink = part.openWrite();
    var n = 0;
    try {
      await for (final c in body) {
        n += c.length;
        if (n > max) break;
        sink.add(c);
      }
    } finally {
      await sink.close();
    }
    if (n > max) {
      await part.delete();
      return null;
    }
    await part.rename(f.path);
    return f.path;
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

/// [rel] of [tab]'s project read into a file of [files]: its path, or why there is none. Never throws.
Future<({String? path, FetchFail? fail})> fetchSound(
  WindowTab tab,
  String rel, {
  ClipFiles? files,
}) async {
  ({String? path, FetchFail? fail}) failed(FetchFail f) =>
      (path: null, fail: f);
  final ch = tab.link.channel;
  if (ch == null) return failed(FetchFail.unreadable);
  try {
    final r = await ch.httpStream(
      tab.port,
      'GET',
      '/file?path=${Uri.encodeQueryComponent(rel)}',
    );
    final bad = fetchFailOf(r.status);
    final length = int.tryParse(r.headers['content-length'] ?? '');
    if (bad != null || (length != null && length > soundMaxBytes)) {
      r.cancel();
      return failed(bad ?? FetchFail.tooLarge);
    }
    final ext = soundPath.firstMatch(rel)![0]!.toLowerCase();
    final name = '${_hash('${tab.link.host.id}|${tab.port}|$rel')}$ext';
    final path = await (files ?? ClipFiles.shared).write(
      name,
      r.body,
      soundMaxBytes,
    );
    if (path == null) {
      r.cancel();
      return failed(FetchFail.tooLarge);
    }
    return (path: path, fail: null);
  } on Object {
    return failed(FetchFail.unreadable);
  }
}

/// The project file [src] (as the reply wrote it) names in [root], or null when it is none.
String? soundFile(String root, String src) {
  var p = src;
  try {
    p = Uri.decodeFull(src);
  } on ArgumentError {
    // kept as written
  }
  return projectPath(root, p);
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

  // whether the last start had its file (and so failed in the player when it is not playing)
  bool _opened = false;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final p = widget.player ?? VoicePlayer.shared;
    final tab = FileOpener.of(context);
    final rel = tab == null ? null : soundFile(tab.root, widget.src);
    final name = widget.src.split('/').last;
    final shownName = (() {
      try {
        return Uri.decodeFull(name);
      } on ArgumentError {
        return name;
      }
    })();
    final id = tab == null || rel == null
        ? null
        : 'clip|${tab.link.host.id}|${tab.port}|$rel';
    Future<String?> open() async {
      final got = await fetchSound(tab!, rel!);
      _opened = got.path != null;
      if (mounted) setState(() => _fail = got.fail);
      return got.path;
    }

    Future<void> toggle() async {
      _opened = false;
      await p.toggleSound(id!, open);
      // the player could not play the file it was given (a format the phone does not know)
      if (mounted && _opened && !p.isCurrent(id)) {
        setState(() => _fail = FetchFail.unreadable);
      }
    }

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
        void seekTo(double dx) => p.seekSound(
          id!,
          open,
          Duration(
            milliseconds: (length!.inMilliseconds * (dx / barWidth).clamp(0, 1))
                .round(),
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
                        FetchFail.tooLarge => t.soundTooLarge,
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
