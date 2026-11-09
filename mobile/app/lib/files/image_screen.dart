// An image of the window, opened over the chat: read through `/file`, zoomed with two fingers, marked up and commented
// as on the desktop (a media anchor, the frame and layer under `/marks`, the agent's frame attached).
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import '../media/markup.dart';
import '../media/media_comment.dart';

/// The largest image the phone opens.
const imageMaxBytes = 32 * 1024 * 1024;

enum _Fail { notFound, outside, tooLarge, unreadable, undecodable }

/// The window's own requests for a tab, through its channel; null while the host is offline.
WindowHttp? windowHttp(WindowTab tab) {
  final ch = tab.link.channel;
  if (ch == null) return null;
  return (method, path, {headers, body}) =>
      ch.http(tab.port, method, path, headers: headers, body: body);
}

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
      images: [r.image],
      genImages: 1,
    );
    return true;
  } catch (_) {
    messenger.showSnackBar(SnackBar(content: Text(t.markFailed)));
    return false;
  }
}

class ImageScreen extends StatefulWidget {
  const ImageScreen({super.key, required this.tab, required this.path});

  final WindowTab tab;

  /// relative to the window's root
  final String path;

  @override
  State<ImageScreen> createState() => _ImageScreenState();
}

class _ImageScreenState extends State<ImageScreen> {
  ui.Image? _image;
  String? _etag;
  _Fail? _fail;
  bool _busy = false;
  final _markup = Markup();
  final _zoom = TransformationController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _image?.dispose();
    _markup.dispose();
    _zoom.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final http = windowHttp(widget.tab);
    if (http == null) return setState(() => _fail = _Fail.unreadable);
    _Fail? fail;
    ui.Image? image;
    String? etag;
    try {
      final ch = widget.tab.link.channel!;
      final r = await ch.httpStream(
        widget.tab.port,
        'GET',
        '/file?path=${Uri.encodeQueryComponent(widget.path)}',
      );
      final length = int.tryParse(r.headers['content-length'] ?? '');
      if (r.status == 404) {
        r.cancel();
        fail = _Fail.notFound;
      } else if (r.status == 403) {
        r.cancel();
        fail = _Fail.outside;
      } else if (r.status != 200) {
        r.cancel();
        fail = _Fail.unreadable;
      } else if (length != null && length > imageMaxBytes) {
        r.cancel();
        fail = _Fail.tooLarge;
      } else {
        // without a length the body is counted as it comes
        final body = BytesBuilder(copy: false);
        await for (final c in r.body) {
          body.add(c);
          if (body.length > imageMaxBytes) {
            fail = _Fail.tooLarge;
            r.cancel();
            break;
          }
        }
        if (fail == null) {
          etag = r.headers['etag'];
          try {
            final codec = await ui.instantiateImageCodec(body.takeBytes());
            image = (await codec.getNextFrame()).image;
            codec.dispose();
          } catch (_) {
            fail = _Fail.undecodable;
          }
        }
      }
    } on Object {
      fail = _Fail.unreadable;
    }
    if (!mounted) {
      image?.dispose();
      return;
    }
    if (etag != null) widget.tab.fileVersions[widget.path] = etag;
    setState(() {
      _fail = fail;
      _image = image;
      _etag = etag;
    });
  }

  Future<void> _comment() async {
    final image = _image;
    if (image == null || _markup.shapes.isEmpty) return;
    final res = await showCommentSheet(
      context,
      quote: widget.path.split('/').last,
      tab: widget.tab,
    );
    if (res is! SheetSave || !mounted) return;
    setState(() => _busy = true);
    final ok = await saveMediaComment(
      context,
      tab: widget.tab,
      path: widget.path,
      source: image,
      shapes: _markup.shapes,
      text: res.text,
      label: res.label,
      version: _etag,
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) _markup.marking = false;
  }

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
    final image = _image, fail = _fail;
    return ListenableBuilder(
      listenable: Listenable.merge([_markup, widget.tab.comments]),
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: Text(widget.path.split('/').last),
          actions: [
            if (image != null && !_markup.marking)
              IconButton(
                tooltip: t.markUp,
                icon: const Icon(Icons.draw_outlined),
                onPressed: () => _markup.marking = true,
              ),
          ],
        ),
        bottomNavigationBar: _markup.marking
            ? MarkupToolbar(markup: _markup, busy: _busy, onComment: _comment)
            : null,
        body: fail != null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(_failText(t, fail), textAlign: TextAlign.center),
                ),
              )
            : image == null
            ? const Center(child: CircularProgressIndicator())
            : _picture(image),
      ),
    );
  }

  Widget _picture(ui.Image image) {
    final layer = MarkupLayer(
      natural: Size(image.width.toDouble(), image.height.toDouble()),
      markup: _markup,
      shown: shownMarks(widget.tab, widget.path),
      child: RawImage(image: image, fit: BoxFit.fill),
    );
    // while marking, a drag draws: the zoom stays where it was but takes no gestures
    return _markup.marking
        ? ClipRect(
            child: Transform(transform: _zoom.value, child: layer),
          )
        : InteractiveViewer(
            transformationController: _zoom,
            maxScale: 8,
            child: layer,
          );
  }
}
