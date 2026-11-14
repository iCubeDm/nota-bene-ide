// An image of the window, opened over the chat: read through `/file`, zoomed with two fingers, marked up and commented
// as on the desktop (a media anchor, the frame and layer under `/marks`, the agent's frame attached).
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import '../media/fetch.dart';
import '../media/markup.dart';
import '../media/media_comment.dart';
import '../media/picker.dart';
import '../media/shapes.dart';
import '../ui/nb_icon.dart';

export '../media/fetch.dart' show imageMaxBytes;

/// The window's own requests for a tab, through its channel; null while the host is offline.
WindowHttp? windowHttp(WindowTab tab) => tab.http;

/// The marks of [path]'s comments, numbered as the strip numbers them.
List<ShownMark> shownMarks(WindowTab tab, String path, {double? at}) {
  final strip = tab.comments.sendable;
  return [
    for (final c in tab.comments.mediaFor(path))
      if (c.anchor case MediaAnchor(
        :final shapes,
        :final time,
      ) when at == null || (time != null && (time - at).abs() < 0.05))
        (
          n: strip.indexWhere((x) => x.id == c.id) + 1,
          shapes: shapes,
          sent: c.status == CommentStatus.sent,
        ),
  ];
}

/// Makes the comment once the sheet is saved: the files first, then the comment with its frame. False when it
/// failed (the user was told; the drawing stays for another try).
Future<bool> saveMediaComment(
  BuildContext context, {
  required WindowTab tab,
  required String path,
  required ui.Image source,
  required List<MediaShape> shapes,
  required String text,
  QuickLabelId? label,
  List<VoiceClip> voice = const [],
  List<String> images = const [],
  String? version,
  double? time,
}) async {
  final t = AppLocalizations.of(context);
  final messenger = ScaffoldMessenger.of(context);
  final http = windowHttp(tab);
  final id = uuidV4();
  try {
    if (http == null) throw MarkSaveError('offline');
    final r = await prepareMediaComment(
      http,
      id,
      source,
      source.width,
      source.height,
      shapes,
    );
    tab.comments.add(
      MediaAnchor(
        source: FileSource(kind: 'file', path: path),
        width: source.width,
        height: source.height,
        time: time,
        version: version,
        scale: r.scale,
        shapes: [...shapes],
      ),
      text,
      label,
      id: id,
      images: [r.image, ...images],
      genImages: 1,
      voice: voice,
    );
    return true;
  } catch (_) {
    messenger.showSnackBar(SnackBar(content: Text(t.markFailed)));
    return false;
  }
}

/// One image of the viewer: a file of the window (a project path, relative; or a temp image, absolute, read from
/// `/tmpimage`) or a message's attachment (read from `/attach/<id>`, nothing to mark up or comment on).
class ViewerImage {
  const ViewerImage.file(String this.path) : attachId = null, label = null;
  const ViewerImage.attach(String this.attachId, this.label) : path = null;

  final String? path, attachId, label;

  String get name => path?.split('/').last ?? label ?? '';

  String get url => attachId != null
      ? '/attach/$attachId'
      : path!.startsWith('/')
      ? '/tmpimage?path=${Uri.encodeQueryComponent(path!)}'
      : '/file?path=${Uri.encodeQueryComponent(path!)}';

  /// Comments anchor to a file's path.
  bool get markable => path != null;
}

enum _Fail { notFound, outside, tooLarge, unreadable, undecodable }

class _Page {
  ui.Image? image;
  Uint8List? bytes;
  String? etag;
  _Fail? fail;
}

class ImageScreen extends StatefulWidget {
  ImageScreen({
    super.key,
    required this.tab,
    String? path,
    List<ViewerImage>? items,
    this.index = 0,
  }) : items = items ?? [ViewerImage.file(path!)];

  final WindowTab tab;

  /// what the viewer swipes through
  final List<ViewerImage> items;

  /// where it opens
  final int index;

  @override
  State<ImageScreen> createState() => _ImageScreenState();
}

class _ImageScreenState extends State<ImageScreen>
    with SingleTickerProviderStateMixin {
  final _pages = <int, _Page>{};
  late int _index = widget.index;
  late final _controller = PageController(initialPage: widget.index);
  bool _busy = false;
  final _markup = Markup();
  final _zoom = TransformationController();
  bool _zoomed = false;

  /// how far a swipe down has carried the picture
  double _drag = 0;

  /// the fingers on the screen: with two, a pinch is under way and the page swipe is locked. The lock lands a frame
  /// after the second finger, so if the first has already moved 18 px sideways by then, PageView has won that whole
  /// pinch and it is lost: a swipe, not a zoom.
  final _fingers = <int>{};
  bool _closing = false;

  /// set while two or more fingers have been down, until all are up
  bool _multi = false;
  late final _glide = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 200),
  );
  Matrix4Tween? _glideTween;
  Offset _tap = Offset.zero;

  ViewerImage get _item => widget.items[_index];
  _Page? get _page => _pages[_index];

  @override
  void initState() {
    super.initState();
    _zoom.addListener(() {
      final z = _zoom.value.getMaxScaleOnAxis() > 1.01;
      if (z != _zoomed) setState(() => _zoomed = z);
    });
    _glide.addListener(() {
      final tween = _glideTween;
      if (tween != null) _zoom.value = tween.evaluate(_glide);
    });
    _load(_index);
  }

  @override
  void dispose() {
    for (final p in _pages.values) {
      p.image?.dispose();
    }
    _controller.dispose();
    _markup.dispose();
    _glide.dispose();
    _zoom.dispose();
    super.dispose();
  }

  /// Lets go of the decoded pictures farther than a page from the current one: a long run of photos would otherwise
  /// stay in memory whole. They are read again when the viewer comes back.
  void _trim() {
    for (final k in [
      for (final k in _pages.keys)
        if ((k - _index).abs() > 1) k,
    ]) {
      _pages.remove(k)?.image?.dispose();
    }
  }

  Future<void> _load(int i) async {
    if (_pages.containsKey(i) || (i - _index).abs() > 1) return;
    final page = _pages[i] = _Page();
    final item = widget.items[i];
    final got = item.attachId != null
        ? await cachedMedia(widget.tab, item.url)
        : await fetchMedia(widget.tab, item.url);
    ui.Image? image;
    _Fail? fail = switch (got.fail) {
      FetchFail.notFound => _Fail.notFound,
      FetchFail.outside => _Fail.outside,
      FetchFail.tooLarge => _Fail.tooLarge,
      FetchFail.unreadable => _Fail.unreadable,
      null => null,
    };
    if (fail == null) {
      try {
        final codec = await ui.instantiateImageCodec(got.bytes!);
        image = (await codec.getNextFrame()).image;
        codec.dispose();
      } catch (_) {
        fail = _Fail.undecodable;
      }
    }
    // the page may have been let go while it was read
    if (!mounted || _pages[i] != page) {
      image?.dispose();
      return;
    }
    if (got.etag != null && item.path != null) {
      widget.tab.fileVersions[item.path!] = got.etag!;
    }
    setState(() {
      page.fail = fail;
      page.image = image;
      page.bytes = got.bytes;
      page.etag = got.etag;
    });
  }

  void _moved(int i) {
    _zoom.value = Matrix4.identity();
    setState(() {
      _index = i;
      _trim();
    });
    _load(i);
  }

  Future<void> _comment() async {
    final image = _page?.image, path = _item.path;
    if (image == null || path == null) return;
    final res = await showCommentSheet(
      context,
      quote: path.split('/').last,
      tab: widget.tab,
    );
    if (res is! SheetSave || !mounted) return;
    setState(() => _busy = true);
    final ok = await saveMediaComment(
      context,
      tab: widget.tab,
      path: path,
      source: image,
      shapes: _markup.shapes,
      text: res.text,
      label: res.label,
      voice: res.voice,
      images: res.images,
      version: _page?.etag,
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) _markup.marking = false;
  }

  Future<void> _share() async {
    final bytes = _page?.bytes;
    if (bytes == null) return;
    final t = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final name = _item.name.isEmpty ? 'image' : _item.name;
    try {
      await shareImage(bytes, imageMime(bytes, name), name);
    } on PlatformException {
      messenger.showSnackBar(SnackBar(content: Text(t.shareFailed)));
    }
  }

  void _touch(PointerEvent e, bool down) {
    final before = _fingers.length > 1;
    down ? _fingers.add(e.pointer) : _fingers.remove(e.pointer);
    if (_fingers.length > 1) _multi = true;
    if (_fingers.isEmpty) _multi = false;
    if (before != _fingers.length > 1) setState(() {});
  }

  /// A one-finger drag at scale 1 carries the picture; a second finger hands the gesture to the pinch, and the finger
  /// left after a pinch is no drag at all (`_multi` holds until every finger is up).
  void _interact(ScaleUpdateDetails d) {
    if (_zoomed || _multi) return;
    if (d.pointerCount != 1) {
      if (_closing || _drag != 0) {
        _closing = false;
        setState(() => _drag = 0);
      }
      return;
    }
    _closing = true;
    setState(() => _drag = (_drag + d.focalPointDelta.dy).clamp(0, 600));
  }

  void _interactEnd(ScaleEndDetails d) {
    // the recognizer also ends a gesture when a finger comes or goes and it starts over: that is no release
    if (d.pointerCount > 0) {
      _closing = false;
      if (_drag != 0) setState(() => _drag = 0);
      return;
    }
    if (!_closing) return;
    _closing = false;
    final close = _drag > 120 || d.velocity.pixelsPerSecond.dy > 800;
    if (close) {
      Navigator.of(context).maybePop();
    } else {
      setState(() => _drag = 0);
    }
  }

  /// A double tap zooms to 2.5x around the tap, or back to 1 when already zoomed; both glide.
  void _doubleTap(Size size) {
    final image = _page?.image;
    if (image == null) return;
    final Matrix4 to;
    if (_zoomed) {
      to = Matrix4.identity();
    } else {
      const s = 2.5;
      // a tap on the black beside the picture zooms on the picture's edge, not on empty space
      final shown = containBox(
        size,
        Size(image.width.toDouble(), image.height.toDouble()),
      );
      final f = Offset(
        _tap.dx.clamp(shown.left, shown.right),
        _tap.dy.clamp(shown.top, shown.bottom),
      );
      to = Matrix4.diagonal3Values(s, s, 1)
        ..setTranslationRaw(
          (f.dx * (1 - s)).clamp(size.width * (1 - s), 0.0),
          (f.dy * (1 - s)).clamp(size.height * (1 - s), 0.0),
          0,
        );
    }
    _glideTween = Matrix4Tween(begin: _zoom.value, end: to);
    _glide
      ..reset()
      ..forward();
  }

  Widget _action(String key, NbGlyph glyph, String label, VoidCallback? on) =>
      Expanded(
        child: Tooltip(
          message: label,
          child: InkWell(
            key: ValueKey(key),
            onTap: on,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  NbIcon(glyph, size: 22, color: Colors.white),
                  const SizedBox(height: 4),
                  Text(
                    label,
                    style: const TextStyle(color: Colors.white70, fontSize: 12),
                  ),
                ],
              ),
            ),
          ),
        ),
      );

  Widget _actions(AppLocalizations t) => ColoredBox(
    color: Colors.black,
    child: SafeArea(
      top: false,
      child: Row(
        children: [
          if (_item.markable)
            _action('act-markup', NbGlyph.pen, t.markUp, () {
              // the zoom carries into marking: small marks are placed zoomed in
              _glide.stop();
              _markup.marking = true;
            }),
          if (_item.markable)
            _action('act-comment', NbGlyph.comments, t.comment, _comment),
          _action('act-share', NbGlyph.share, t.share, _share),
        ],
      ),
    ),
  );

  String _failText(AppLocalizations t, _Fail f) => switch (f) {
    _Fail.notFound => t.fileNotFound,
    _Fail.outside => t.fileOutside,
    _Fail.tooLarge => t.imageTooLarge,
    _Fail.unreadable => t.fileUnreadable,
    _Fail.undecodable => t.imageUnreadable,
  };

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final image = _page?.image;
    final many = widget.items.length > 1;
    return ListenableBuilder(
      listenable: Listenable.merge([_markup, widget.tab.comments]),
      builder: (context, _) => Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(
          backgroundColor: Colors.black,
          foregroundColor: Colors.white,
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_item.name, style: const TextStyle(fontSize: 16)),
              if (many)
                Text(
                  '${_index + 1} / ${widget.items.length}',
                  style: const TextStyle(fontSize: 12, color: Colors.white70),
                ),
            ],
          ),
        ),
        bottomNavigationBar: _markup.marking
            ? MarkupToolbar(markup: _markup, busy: _busy, onComment: _comment)
            : image != null
            ? _actions(t)
            : null,
        body: DefaultTextStyle.merge(
          style: const TextStyle(color: Colors.white),
          child: Listener(
            onPointerDown: (e) => _touch(e, true),
            onPointerUp: (e) => _touch(e, false),
            onPointerCancel: (e) => _touch(e, false),
            child: PageView.builder(
              controller: _controller,
              itemCount: widget.items.length,
              physics: _markup.marking || _zoomed || _fingers.length > 1
                  ? const NeverScrollableScrollPhysics()
                  : null,
              onPageChanged: _moved,
              itemBuilder: (context, i) {
                _load(i);
                final p = _pages[i];
                final fail = p?.fail, image = p?.image;
                return fail != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            _failText(t, fail),
                            textAlign: TextAlign.center,
                          ),
                        ),
                      )
                    : image == null
                    ? const Center(child: CircularProgressIndicator())
                    : _picture(i, image);
              },
            ),
          ),
        ),
      ),
    );
  }

  Widget _picture(int i, ui.Image image) {
    final item = widget.items[i];
    final layer = MarkupLayer(
      natural: Size(image.width.toDouble(), image.height.toDouble()),
      markup: _markup,
      shown: item.path == null ? const [] : shownMarks(widget.tab, item.path!),
      child: RawImage(image: image, fit: BoxFit.fill),
    );
    // while marking, one finger draws and two zoom
    if (_markup.marking) {
      return MarkupZoom(zoom: _zoom, markup: _markup, child: layer);
    }
    final viewer = InteractiveViewer(
      transformationController: i == _index ? _zoom : null,
      minScale: 1,
      maxScale: 8,
      panEnabled: !(i == _index && !_zoomed),
      onInteractionStart: i == _index ? (_) => _glide.stop() : null,
      onInteractionUpdate: i == _index ? _interact : null,
      onInteractionEnd: i == _index ? _interactEnd : null,
      child: layer,
    );
    // the close drag rides on the viewer's own gesture, not a competing drag recognizer that would win over a pinch
    return LayoutBuilder(
      builder: (context, box) => GestureDetector(
        behavior: HitTestBehavior.opaque,
        onDoubleTapDown: (d) => _tap = d.localPosition,
        onDoubleTap: i == _index ? () => _doubleTap(box.biggest) : null,
        child: Transform.translate(
          offset: Offset(0, i == _index ? _drag : 0),
          child: viewer,
        ),
      ),
    );
  }
}
