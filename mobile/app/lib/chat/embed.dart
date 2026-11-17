// A project's file embedded in Markdown as an image (`![](design/shot.png)`, `![](media/clip.mp4)`, a sound): where
// its path points, and the preview of an image or a video (issue 459). The chat's paths are the project's; a Markdown
// file opened full screen gives its own folder ([EmbedScope]). A tap opens the file in the phone's own viewer.
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../media/fetch.dart';
import '../theme.dart';
import 'files.dart';
import 'window_tab.dart';

/// The project file [src] (as the text wrote it) names in [root], relative to [base] (a folder of the project, `''`
/// for its root), or null when it is none (outside the project included).
String? embedFile(String root, String src, {String base = ''}) {
  final p = decodedName(src);
  if (p.startsWith('/')) return projectPath(root, p);
  final out = <String>[];
  for (final seg in [...base.split('/'), ...p.split('/')]) {
    if (seg.isEmpty || seg == '.') continue;
    if (seg == '..') {
      if (out.isEmpty) return null;
      out.removeLast();
    } else {
      out.add(seg);
    }
  }
  return projectPath(root, out.join('/'));
}

/// [s] with its `%xx` decoded, or as written when it is not valid.
String decodedName(String s) {
  try {
    return Uri.decodeFull(s);
  } on ArgumentError {
    return s;
  }
}

/// Where the embeds below read from: the window, and the folder their paths are relative to (a Markdown file's own;
/// the chat has none, its paths are the project's).
class EmbedScope extends InheritedWidget {
  const EmbedScope({
    super.key,
    required this.tab,
    required this.base,
    required super.child,
  });
  final WindowTab tab;
  final String base;

  static EmbedScope? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<EmbedScope>();

  @override
  bool updateShouldNotify(EmbedScope old) => old.tab != tab || old.base != base;
}

/// What an embed [src] names here: the window (null outside one) and the project file (null when it names none).
({WindowTab? tab, String? rel}) embedTarget(BuildContext context, String src) {
  final scope = EmbedScope.of(context);
  final tab = scope?.tab ?? FileOpener.of(context);
  return (
    tab: tab,
    rel: tab == null ? null : embedFile(tab.root, src, base: scope?.base ?? ''),
  );
}

/// The tallest an embedded image is drawn in the text; the widest is [embedMaxWidth].
const embedMaxHeight = 240.0;
const embedMaxWidth = 360.0;

/// Whether [rel] of [tab]'s window can be read, asking for its first byte only (a video is not fetched to show its
/// tile). Never throws.
Future<FetchFail?> probeFile(WindowTab tab, String rel) async {
  final ch = tab.link.channel;
  if (ch == null) return FetchFail.unreadable;
  try {
    final r = await ch.httpStream(
      tab.port,
      'GET',
      '/file?path=${Uri.encodeQueryComponent(rel)}',
      headers: const {'range': 'bytes=0-0'},
    );
    r.cancel();
    return r.status == 206 ? null : fetchFailOf(r.status);
  } on Object {
    return FetchFail.unreadable;
  }
}

/// An image or a video of the project embedded in the text: an image as a preview (its aspect kept, at most
/// [embedMaxHeight] tall), a video as a tile with a play mark and its name. A tap opens it full screen; a file that
/// cannot be shown is a row saying why.
class EmbeddedMedia extends StatefulWidget {
  const EmbeddedMedia(this.src, {super.key, required this.video});

  /// The path as the text wrote it: relative to the project's root (or the file's folder), or absolute inside it.
  final String src;
  final bool video;

  @override
  State<EmbeddedMedia> createState() => _EmbeddedMediaState();
}

class _EmbeddedMediaState extends State<EmbeddedMedia> {
  // the read for the current target, by its key (window and path): a rebuild does not read again
  String? _key;
  Future<Fetched>? _image;
  Future<FetchFail?>? _probe;

  // a picture that came but does not decode
  bool _undecodable = false;

  void _read(WindowTab tab, String rel) {
    final key = '${tab.link.host.id}|${tab.port}|$rel|${widget.video}';
    if (key == _key) return;
    _key = key;
    _undecodable = false;
    // a file is read by each preview that shows it, as the tool lines' cards read theirs: it changes or goes
    if (widget.video) {
      _probe = probeFile(tab, rel);
      _image = null;
    } else {
      _image = cachedMedia(tab, '/file?path=${Uri.encodeQueryComponent(rel)}');
      _probe = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final (:tab, :rel) = embedTarget(context, widget.src);
    final name = decodedName(widget.src.split('/').last);
    if (tab == null) return _row(context, name, null);
    if (rel == null) return _row(context, name, FetchFail.outside);
    _read(tab, rel);
    void open() => openFile(context, tab, rel);
    if (widget.video) {
      return FutureBuilder<FetchFail?>(
        future: _probe,
        builder: (context, s) => s.connectionState == ConnectionState.done
            ? s.data != null
                  ? _row(context, name, s.data)
                  : _videoTile(context, name, open)
            : _videoTile(context, name, null),
      );
    }
    return FutureBuilder<Fetched>(
      future: _image,
      builder: (context, s) {
        final got = s.data;
        if (got == null) return _loading(context);
        if (got.bytes == null || _undecodable) {
          return _row(context, name, got.fail, undecodable: _undecodable);
        }
        return _picture(context, name, got.bytes!, open);
      },
    );
  }

  Widget _loading(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Container(
        width: 160,
        height: 90,
        decoration: BoxDecoration(
          color: c.codeBg,
          borderRadius: BorderRadius.circular(8),
        ),
        alignment: Alignment.center,
        child: const SizedBox.square(
          dimension: 18,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      ),
    );
  }

  Widget _picture(
    BuildContext context,
    String name,
    Uint8List bytes,
    VoidCallback open,
  ) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Semantics(
      button: true,
      label: name,
      child: GestureDetector(
        onTap: open,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: embedMaxWidth,
              maxHeight: embedMaxHeight,
            ),
            // decoded no wider than drawn; a small picture stays its size
            child: Image.memory(
              bytes,
              fit: BoxFit.contain,
              cacheWidth:
                  (embedMaxWidth * MediaQuery.devicePixelRatioOf(context))
                      .round(),
              gaplessPlayback: true,
              errorBuilder: (_, _, _) {
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted && !_undecodable) {
                    setState(() => _undecodable = true);
                  }
                });
                return const SizedBox.shrink();
              },
            ),
          ),
        ),
      ),
    ),
  );

  Widget _videoTile(BuildContext context, String name, VoidCallback? open) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: GestureDetector(
        onTap: open,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Container(
            width: 240,
            color: c.codeBg,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(
                  height: 135,
                  child: Center(
                    child: Icon(Icons.play_arrow, size: 40, color: c.mutedFg),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: c.mutedFg, fontSize: 12),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The file's name and, under it, why it does not show ([fail]; none outside a window).
  Widget _row(
    BuildContext context,
    String name,
    FetchFail? fail, {
    bool undecodable = false,
  }) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final why = undecodable
        ? t.imageUnreadable
        : switch (fail) {
            FetchFail.notFound => t.fileNotFound,
            FetchFail.outside => t.fileOutside,
            FetchFail.tooLarge => t.imageTooLarge,
            FetchFail.unreadable => t.fileUnreadable,
            null => null,
          };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            widget.video ? Icons.movie_outlined : Icons.image_outlined,
            size: 20,
            color: c.mutedFg,
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: c.foreground, fontSize: 13),
                ),
                if (why != null)
                  Text(why, style: TextStyle(color: c.mutedFg, fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
