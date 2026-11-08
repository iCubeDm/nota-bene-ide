// Mermaid diagrams as images: the desktop's own mermaid.js draws them in an offscreen WebView page
// (assets/mermaid/render.html), which returns a PNG. Never the source: a diagram mermaid rejects shows its error.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';

class MermaidImage {
  MermaidImage(this.png, this.width, this.height);
  final Uint8List png;

  /// the drawing's own size in logical pixels
  final double width, height;
}

/// Mermaid itself rejected the diagram: [message] is its own error line.
class MermaidError implements Exception {
  MermaidError(this.message);
  final String message;
  @override
  String toString() => message;
}

/// The renderer did not answer in time (a cold WebView, the app locked): worth another try later.
class MermaidTimeout implements Exception {}

abstract class MermaidRenderer {
  Future<MermaidImage> render(
    String source, {
    required bool dark,
    required double scale,
  });

  /// The widget that must be in the tree for the renderer to work (the hidden WebView), or null.
  Widget? get engine;
}

/// Draws each source once per theme and scale; mermaid's own rejection is remembered too, a timeout is not.
class CachedMermaid implements MermaidRenderer {
  CachedMermaid(this._inner);
  final MermaidRenderer _inner;
  final _cache = <String, Future<MermaidImage>>{};

  @override
  Future<MermaidImage> render(
    String source, {
    required bool dark,
    required double scale,
  }) {
    final key = '$dark|$scale|$source';
    return _cache.putIfAbsent(key, () {
      final f = _inner.render(source, dark: dark, scale: scale);
      f.then<void>(
        (_) {},
        onError: (Object e) {
          if (e is! MermaidError) _cache.remove(key);
        },
      );
      return f;
    });
  }

  @override
  Widget? get engine => _inner.engine;
}

/// One hidden WebView for the app; one diagram at a time.
class WebViewMermaid implements MermaidRenderer {
  WebViewMermaid() {
    _c
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('NB', onMessageReceived: (m) => _answer(m.message))
      ..setNavigationDelegate(
        NavigationDelegate(
          // the page is the app's own asset; it may not go anywhere else
          onNavigationRequest: (r) => r.url.startsWith('file:///android_asset/')
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
          onPageFinished: (_) {
            if (!_ready.isCompleted) _ready.complete();
          },
        ),
      )
      ..loadFlutterAsset('assets/mermaid/render.html');
  }

  final _c = WebViewController();
  final _ready = Completer<void>();
  final _pending = <String, Completer<MermaidImage>>{};
  Future<void> _queue = Future.value();
  int _seq = 0;

  void _answer(String msg) {
    final j = jsonDecode(msg) as Map<String, Object?>;
    final done = _pending.remove(j['id']);
    if (done == null || done.isCompleted) return; // an answer after its timeout
    final png = j['png'];
    if (png is String && png.startsWith('data:image/png;base64,')) {
      done.complete(
        MermaidImage(
          base64Decode(png.substring(png.indexOf(',') + 1)),
          (j['w'] as num).toDouble(),
          (j['h'] as num).toDouble(),
        ),
      );
    } else {
      final err = j['error'];
      done.completeError(
        err is String && err.isNotEmpty ? MermaidError(err) : MermaidTimeout(),
      );
    }
  }

  @override
  Future<MermaidImage> render(
    String source, {
    required bool dark,
    required double scale,
  }) {
    final out = Completer<MermaidImage>();
    _queue = _queue
        .then((_) async {
          await _ready.future.timeout(const Duration(seconds: 20));
          final id = 'r${_seq++}';
          _pending[id] = out;
          try {
            await _c.runJavaScript(
              'render(${jsonEncode(id)}, ${jsonEncode(source)}, $dark, $scale)',
            );
            await out.future.timeout(const Duration(seconds: 20));
          } finally {
            _pending.remove(id);
          }
        })
        .catchError((Object e) {
          if (!out.isCompleted) {
            out.completeError(e is MermaidError ? e : MermaidTimeout());
          }
        });
    return out.future;
  }

  @override
  Widget get engine => WebViewWidget(controller: _c);
}

/// Provides the renderer below it and keeps its engine in the tree, invisible.
class MermaidScope extends StatelessWidget {
  const MermaidScope({super.key, required this.renderer, required this.child});

  final MermaidRenderer renderer;
  final Widget child;

  static MermaidRenderer? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_MermaidScope>()?.renderer;

  @override
  Widget build(BuildContext context) {
    final engine = renderer.engine;
    return _MermaidScope(
      renderer: renderer,
      child: engine == null
          ? child
          : Stack(
              children: [
                child,
                Positioned(
                  left: 0,
                  top: 0,
                  width: 2,
                  height: 2,
                  child: IgnorePointer(
                    child: Opacity(opacity: 0.01, child: engine),
                  ),
                ),
              ],
            ),
    );
  }
}

class _MermaidScope extends InheritedWidget {
  const _MermaidScope({required this.renderer, required super.child});
  final MermaidRenderer renderer;
  @override
  bool updateShouldNotify(_MermaidScope old) => old.renderer != renderer;
}

class MermaidBlock extends StatefulWidget {
  const MermaidBlock(this.source, {super.key});
  final String source;

  @override
  State<MermaidBlock> createState() => _MermaidBlockState();
}

class _MermaidBlockState extends State<MermaidBlock> {
  Future<MermaidImage>? _image;

  void _draw() => _image = MermaidScope.of(context)?.render(
    widget.source,
    dark: true,
    scale: MediaQuery.devicePixelRatioOf(context),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_image == null) _draw();
  }

  /// A reply still streaming grows its diagram: each new source is drawn again.
  @override
  void didUpdateWidget(MermaidBlock old) {
    super.didUpdateWidget(old);
    if (old.source != widget.source) _draw();
  }

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    Widget frame(Widget child) => Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        border: Border.all(color: c.border),
        borderRadius: BorderRadius.circular(6),
      ),
      child: child,
    );
    return FutureBuilder<MermaidImage>(
      future: _image,
      builder: (context, snap) {
        if (snap.hasError || _image == null) {
          final e = snap.error;
          return frame(
            Text(
              e is MermaidError
                  ? e.message
                  : AppLocalizations.of(context).diagramFailed,
              style: TextStyle(color: c.mutedFg),
            ),
          );
        }
        final img = snap.data;
        if (img == null) {
          return frame(
            const SizedBox(
              height: 48,
              child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
            ),
          );
        }
        return GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => Scaffold(
                appBar: AppBar(),
                body: InteractiveViewer(
                  maxScale: 8,
                  child: Center(
                    child: Image.memory(
                      img.png,
                      width: img.width,
                      height: img.height,
                    ),
                  ),
                ),
              ),
            ),
          ),
          child: frame(
            LayoutBuilder(
              builder: (context, box) => Image.memory(
                img.png,
                width: img.width < box.maxWidth ? img.width : box.maxWidth,
                fit: BoxFit.contain,
              ),
            ),
          ),
        );
      },
    );
  }
}
