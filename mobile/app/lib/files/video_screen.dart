// A video of the window, played from the host through the channel (a loopback proxy gives the player a URL), paused on a
// frame to mark it up and comment as on an image: the frame Android takes at the playhead is the comment's picture,
// its time the anchor's `time`; the media comments already on the file are ticks on the progress bar.
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_protocol/nb_protocol.dart';
import 'package:video_player/video_player.dart';

import '../chat/window_tab.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import '../media/frame.dart';
import '../media/markup.dart';
import '../media/proxy.dart';
import '../media/shapes.dart';
import 'image_screen.dart';

class VideoScreen extends StatefulWidget {
  const VideoScreen({
    super.key,
    required this.tab,
    required this.path,
    this.at,
    @visibleForTesting this.startProxy = MediaProxy.start,
  });

  final WindowTab tab;

  /// relative to the window's root
  final String path;

  /// where to open it, in seconds: paused there
  final double? at;

  final Future<MediaProxy> Function(OpenMedia) startProxy;

  @override
  State<VideoScreen> createState() => _VideoScreenState();
}

class _VideoScreenState extends State<VideoScreen> {
  MediaProxy? _proxy;
  VideoPlayerController? _controller;
  bool _ready = false;
  bool _failed = false;
  bool _disposed = false;
  String? _etag;
  ui.Image? _frame;
  Duration _framePosition = Duration.zero;
  bool _taking = false;
  bool _busy = false;
  final _markup = Markup();
  final _frameZoom = TransformationController();

  @override
  void initState() {
    super.initState();
    _open();
  }

  @override
  void dispose() {
    _disposed = true;
    _controller?.dispose();
    _proxy?.close();
    _frame?.dispose();
    _markup.dispose();
    _frameZoom.dispose();
    super.dispose();
  }

  /// The file's request on the channel; the first answer's etag is the comments' version.
  Future<HttpStreamAnswer> _openMedia(
    String method,
    Map<String, String> headers,
  ) async {
    final ch = widget.tab.link.channel;
    if (ch == null) throw StateError('offline');
    final a = await ch.httpStream(
      widget.tab.port,
      method,
      '/file?path=${Uri.encodeQueryComponent(widget.path)}',
      headers: headers,
    );
    final etag = a.headers['etag'];
    if (_etag == null && etag != null) {
      _etag = etag;
      widget.tab.fileVersions[widget.path] = etag;
    }
    return a;
  }

  Future<void> _open() async {
    if (widget.tab.link.channel == null) return setState(() => _failed = true);
    try {
      final proxy = await widget.startProxy(_openMedia);
      if (_disposed) return unawaited(proxy.close());
      _proxy = proxy;
      final controller = VideoPlayerController.networkUrl(proxy.uri);
      _controller = controller;
      await controller.initialize();
      if (_disposed) return;
      if (controller.value.hasError) throw StateError('video');
      if (widget.at case final at?) {
        await controller.seekTo(Duration(milliseconds: (at * 1000).round()));
      }
    } on Object {
      if (!_disposed) setState(() => _failed = true);
      return;
    }
    if (!_disposed) setState(() => _ready = true);
  }

  Future<void> _markUp() async {
    final controller = _controller, proxy = _proxy;
    if (controller == null || proxy == null || _taking) return;
    final t = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _taking = true);
    ui.Image? frame;
    Duration? position;
    try {
      await controller.pause();
      // the cached value lags the playhead by up to ~100 ms
      position = await controller.position ?? controller.value.position;
      final f = await frameAt(proxy.uri, position);
      final codec = await ui.instantiateImageCodec(f.png);
      frame = (await codec.getNextFrame()).image;
      codec.dispose();
    } on Object catch (e) {
      if (e is! PlatformException && e is! Exception) rethrow;
      frame = null;
    } finally {
      // an unexpected error must not leave Mark up disabled
      if (!_disposed) setState(() => _taking = false);
    }
    if (_disposed) return frame?.dispose();
    if (frame == null || position == null) {
      messenger.showSnackBar(SnackBar(content: Text(t.frameFailed)));
      return;
    }
    _frame?.dispose();
    _frame = frame;
    _framePosition = position;
    _frameZoom.value = Matrix4.identity();
    _markup.marking = true;
  }

  Future<void> _comment() async {
    final frame = _frame;
    if (frame == null || _markup.shapes.isEmpty) return;
    final res = await showCommentSheet(
      context,
      quote:
          '${widget.path.split('/').last} @ '
          '${mediaTime(_framePosition.inMilliseconds / 1000)}',
      tab: widget.tab,
    );
    if (res is! SheetSave || !mounted) return;
    setState(() => _busy = true);
    final ok = await saveMediaComment(
      context,
      tab: widget.tab,
      path: widget.path,
      source: frame,
      shapes: _markup.shapes,
      text: res.text,
      label: res.label,
      voice: res.voice,
      images: res.images,
      version: _etag,
      time: _framePosition.inMilliseconds / 1000,
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) {
      _markup.marking = false;
      setState(() {
        _frame?.dispose();
        _frame = null;
      });
    }
  }

  Future<void> _seek(Duration to) async {
    final c = _controller;
    if (c == null) return;
    await c.pause();
    await c.seekTo(to);
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([_markup, widget.tab.comments]),
      builder: (context, _) => Scaffold(
        appBar: AppBar(
          title: Text(widget.path.split('/').last),
          actions: [
            if (_ready && !_markup.marking)
              // a player that errored has nothing to take a frame of
              ValueListenableBuilder<VideoPlayerValue>(
                valueListenable: _controller!,
                builder: (context, v, _) => v.hasError
                    ? const SizedBox.shrink()
                    : IconButton(
                        tooltip: t.markUp,
                        icon: const Icon(Icons.draw_outlined),
                        onPressed: _taking ? null : _markUp,
                      ),
              ),
          ],
        ),
        bottomNavigationBar: _markup.marking
            ? MarkupToolbar(markup: _markup, busy: _busy, onComment: _comment)
            : null,
        body: _body(t),
      ),
    );
  }

  Widget _body(AppLocalizations t) {
    final controller = _controller, frame = _frame;
    if (_failed) return _unplayable(t);
    if (!_ready || controller == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (frame != null && _markup.marking) {
      return MarkupZoom(
        zoom: _frameZoom,
        markup: _markup,
        child: MarkupLayer(
          natural: Size(frame.width.toDouble(), frame.height.toDouble()),
          markup: _markup,
          shown: const [],
          child: RawImage(image: frame, fit: BoxFit.fill),
        ),
      );
    }
    return _player(controller, t);
  }

  Widget _unplayable(AppLocalizations t) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Text(t.videoUnplayable, textAlign: TextAlign.center),
    ),
  );

  Widget _player(VideoPlayerController c, AppLocalizations t) =>
      ValueListenableBuilder<VideoPlayerValue>(
        valueListenable: c,
        builder: (context, v, _) {
          if (v.hasError) return _unplayable(t);
          final playing = v.isPlaying;
          return Column(
            children: [
              Expanded(
                child: Center(
                  child: MarkupLayer(
                    natural: v.size,
                    markup: _markup,
                    shown: playing
                        ? const []
                        : shownMarks(
                            widget.tab,
                            widget.path,
                            at: v.position.inMilliseconds / 1000,
                          ),
                    child: AspectRatio(
                      aspectRatio: v.aspectRatio,
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          VideoPlayer(c),
                          if (v.isBuffering) const CircularProgressIndicator(),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              SafeArea(
                child: Row(
                  children: [
                    IconButton(
                      tooltip: playing ? t.videoPause : t.videoPlay,
                      icon: Icon(playing ? Icons.pause : Icons.play_arrow),
                      onPressed: () => playing ? c.pause() : c.play(),
                    ),
                    Text(mediaTime(v.position.inMilliseconds / 1000)),
                    Expanded(child: _progress(c, v)),
                  ],
                ),
              ),
            ],
          );
        },
      );

  /// The progress bar, a tick on it for each media comment of the file.
  Widget _progress(VideoPlayerController c, VideoPlayerValue v) {
    final total = v.duration.inMilliseconds;
    if (total <= 0) return const SizedBox(height: 48);
    return LayoutBuilder(
      builder: (context, box) {
        // the slider's track starts and ends this far inside its box
        const pad = 24.0;
        final width = box.maxWidth - 2 * pad;
        return SizedBox(
          height: 48,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Slider(
                value: v.position.inMilliseconds.clamp(0, total).toDouble(),
                max: total.toDouble(),
                onChanged: (x) => c.seekTo(Duration(milliseconds: x.round())),
              ),
              for (final k in widget.tab.comments.mediaFor(widget.path))
                if (k.anchor case MediaAnchor(:final time?))
                  Positioned(
                    left: pad + width * (time * 1000 / total).clamp(0, 1) - 10,
                    top: 0,
                    child: GestureDetector(
                      key: ValueKey('tick-${k.id}'),
                      behavior: HitTestBehavior.opaque,
                      onTap: () =>
                          _seek(Duration(milliseconds: (time * 1000).round())),
                      child: SizedBox(
                        width: 20,
                        height: 16,
                        child: Center(
                          child: Container(
                            width: 3,
                            height: 12,
                            color: Theme.of(context).colorScheme.primary,
                          ),
                        ),
                      ),
                    ),
                  ),
            ],
          ),
        );
      },
    );
  }
}
