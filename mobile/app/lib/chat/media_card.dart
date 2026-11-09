// Pictures in the feed: a user message's images above its text, and under a tool line the image or video the call
// names (a screenshot in a temp folder, a file of the project). Images are read through the window's channel once per
// tab (WindowTab.mediaCache); a video is fetched only when it is opened.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../files/image_screen.dart';
import '../l10n/app_localizations.dart';
import '../media/fetch.dart';
import '../theme.dart';
import 'feed.dart';
import 'files.dart';
import 'window_tab.dart';

final _tmpImage = RegExp(
  r'\.(png|jpe?g|gif|webp|avif|bmp)$',
  caseSensitive: false,
);

/// An absolute image path lexically under a temp folder of the window (as web/src/files/tmpImages.ts).
bool isTmpImagePath(String abs, List<String> dirs) {
  if (!abs.startsWith('/') ||
      abs.startsWith('//') ||
      RegExp(r'[\n\x00`<>|*]').hasMatch(abs) ||
      !_tmpImage.hasMatch(abs) ||
      abs.split('/').any((s) => s == '..' || s == '.')) {
    return false;
  }
  return dirs.any((d) => abs.startsWith('$d/') && abs.length > d.length + 1);
}

/// The temp image paths in a line of text (a Bash command, a Read's file_path), in order, once each.
List<String> tmpImagePathsIn(String text, List<String> dirs) => {
  for (final m in RegExp(
    r'''(?:^|[\s"'=(:])(/[^\s"'`<>|*;()]+)''',
  ).allMatches(text))
    if (isTmpImagePath(m.group(1)!, dirs)) m.group(1)!,
}.toList();

/// What a card shows: a [path] relative to the project, or an absolute temp image.
class MediaSpec {
  const MediaSpec(this.path, {required this.video, required this.tmp});
  final String path;
  final bool video, tmp;
  String get name => path.split('/').last;

  @override
  bool operator ==(Object other) => other is MediaSpec && other.path == path;
  @override
  int get hashCode => path.hashCode;
}

const _cardsMax = 3;
const _toolArgs = ['file_path', 'path', 'notebook_path', 'command'];

/// The pictures a finished tool call names, at most [_cardsMax]: its own file when it is an image or a video of the
/// project, and the temp images in its arguments.
List<MediaSpec> mediaOf(WindowTab tab, ToolItem it) {
  if (it.result == null || it.isError) return const [];
  final out = <MediaSpec>[];
  final path = toolPath(it);
  final rel = path == null ? null : projectFile(tab.root, path);
  if (rel != null) {
    switch (fileKindOf(rel)) {
      case FileKind.image:
        out.add(MediaSpec(rel, video: false, tmp: false));
      case FileKind.video:
        out.add(MediaSpec(rel, video: true, tmp: false));
      default:
    }
  }
  for (final k in _toolArgs) {
    if (it.input[k] case final String v) {
      for (final p in tmpImagePathsIn(v, tab.tmpDirs)) {
        out.add(MediaSpec(p, video: false, tmp: true));
      }
    }
  }
  return out.toSet().take(_cardsMax).toList();
}

ViewerImage _viewerOf(MediaSpec s) => ViewerImage.file(s.path);

void openViewer(
  BuildContext context,
  WindowTab tab,
  List<ViewerImage> items,
  int index,
) => Navigator.of(context).push(
  MaterialPageRoute<void>(
    builder: (_) => ImageScreen(tab: tab, items: items, index: index),
  ),
);

/// An image of the window read once for the tab: its bytes, or why it has none.
class _Picture extends StatefulWidget {
  const _Picture({required this.tab, required this.url, required this.width});
  final WindowTab tab;
  final String url;

  /// the width it is drawn at, to decode no more than that
  final double width;

  @override
  State<_Picture> createState() => _PictureState();
}

class _PictureState extends State<_Picture> {
  late final Future<Fetched> _got = cachedMedia(widget.tab, widget.url);

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    return FutureBuilder<Fetched>(
      future: _got,
      builder: (context, s) {
        final got = s.data;
        if (got == null) {
          return const Center(
            child: SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          );
        }
        if (got.bytes == null) {
          return Center(
            child: Text(
              switch (got.fail) {
                FetchFail.notFound => t.fileNotFound,
                FetchFail.outside => t.fileOutside,
                FetchFail.tooLarge => t.imageTooLarge,
                _ => t.fileUnreadable,
              },
              textAlign: TextAlign.center,
              style: TextStyle(color: c.mutedFg, fontSize: 12),
            ),
          );
        }
        return Image.memory(
          got.bytes!,
          fit: BoxFit.cover,
          width: double.infinity,
          height: double.infinity,
          cacheWidth: (widget.width * MediaQuery.devicePixelRatioOf(context))
              .round(),
          gaplessPlayback: true,
          errorBuilder: (_, _, _) => Center(
            child: Text(
              t.imageUnreadable,
              style: TextStyle(color: c.mutedFg, fontSize: 12),
            ),
          ),
        );
      },
    );
  }
}

/// One image of a user message.
class AttachThumb extends StatelessWidget {
  const AttachThumb({
    super.key,
    required this.tab,
    required this.image,
    required this.width,
    required this.height,
    required this.onTap,
  });
  final WindowTab tab;
  final ImageRef image;
  final double width, height;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Container(
          width: width,
          height: height,
          color: c.codeBg,
          child: _Picture(tab: tab, url: '/attach/${image.id}', width: width),
        ),
      ),
    );
  }
}

/// A user message's images above its text: one as wide as the bubble, more in two columns. A tap opens the viewer
/// on that image, with the message's images to swipe through.
class UserImages extends StatelessWidget {
  const UserImages({super.key, required this.tab, required this.images});
  final WindowTab tab;
  final List<ImageRef> images;

  @override
  Widget build(BuildContext context) {
    final items = [for (final i in images) ViewerImage.attach(i.id, i.label)];
    return LayoutBuilder(
      builder: (context, box) {
        final w = box.maxWidth.isFinite ? box.maxWidth : 240.0;
        final one = images.length == 1;
        final cell = one ? w : (w - 4) / 2;
        return Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              for (final (i, im) in images.indexed)
                AttachThumb(
                  tab: tab,
                  image: im,
                  width: cell,
                  height: one ? w * 9 / 16 : cell * 3 / 4,
                  onTap: () => openViewer(context, tab, items, i),
                ),
            ],
          ),
        );
      },
    );
  }
}

/// The image or video a tool call named, under its line: an image is 16:9 (cover), a video a play icon, both with the
/// file's name; a tap opens the viewer or the video screen.
class MediaCard extends StatelessWidget {
  const MediaCard({super.key, required this.tab, required this.spec});
  final WindowTab tab;
  final MediaSpec spec;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final s = spec;
    final url = s.tmp
        ? '/tmpimage?path=${Uri.encodeQueryComponent(s.path)}'
        : '/file?path=${Uri.encodeQueryComponent(s.path)}';
    return Padding(
      padding: const EdgeInsets.only(left: 20, top: 4, bottom: 4),
      child: Align(
        alignment: Alignment.centerLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: GestureDetector(
            onTap: () => s.video
                ? openFile(context, tab, s.path)
                : openViewer(context, tab, [_viewerOf(s)], 0),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Container(
                color: c.codeBg,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    AspectRatio(
                      aspectRatio: 16 / 9,
                      child: s.video
                          ? Center(
                              child: Icon(
                                Icons.play_arrow,
                                size: 40,
                                color: c.mutedFg,
                              ),
                            )
                          : LayoutBuilder(
                              builder: (context, box) => _Picture(
                                tab: tab,
                                url: url,
                                width: box.maxWidth,
                              ),
                            ),
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      child: Text(
                        s.name,
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
        ),
      ),
    );
  }
}
