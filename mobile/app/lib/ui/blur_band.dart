// The blur under floating chrome (the header and tabs on top, the message field below), as in Telegram: what scrolls
// under it is blurred and dimmed, strongest at the screen's edge and fading to clear toward the feed, no hard edge.
// One backdrop filter per band, shared through the nearest BackdropGroup.
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../theme.dart';

/// How far above the field's top the bottom blur begins to fade in.
const blurFade = 24.0;

/// The blurred band: [top] puts the strong end at its top edge, else at its bottom edge; the clear end is [fade] long
/// (the whole band when null). Passes touches through to the chrome and the feed.
class BlurBand extends StatelessWidget {
  const BlurBand({super.key, required this.top, this.fade});
  final bool top;
  final double? fade;

  static const _sigma = 12.0;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return IgnorePointer(
      child: ExcludeSemantics(
        child: ClipRect(
          child: LayoutBuilder(
            builder: (context, box) {
              // the strength along the band: 1 at the strong end, 0 at the clear one
              final ramp = fade == null || box.maxHeight <= 0
                  ? 0.6
                  : (fade! / box.maxHeight).clamp(0.0, 1.0);
              final alphas = top ? [1.0, 1.0, 0.0] : [0.0, 1.0, 1.0];
              final stops = top ? [0.0, 1 - ramp, 1.0] : [0.0, ramp, 1.0];
              return ShaderMask(
                blendMode: BlendMode.dstIn,
                shaderCallback: (r) => LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    for (final a in alphas) Colors.black.withValues(alpha: a),
                  ],
                  stops: stops,
                ).createShader(r),
                child: BackdropFilter.grouped(
                  filter: ImageFilter.blur(sigmaX: _sigma, sigmaY: _sigma),
                  child: ColoredBox(
                    color: c.background.withValues(alpha: 0.55),
                    child: const SizedBox.expand(),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

/// Reports its child's size after layout, when it changes: the floating band's height, which the feed keeps clear.
class SizeReporter extends SingleChildRenderObjectWidget {
  const SizeReporter({super.key, required this.onSize, super.child});
  final ValueChanged<Size> onSize;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderSizeReporter(onSize);

  @override
  void updateRenderObject(
    BuildContext context,
    RenderSizeReporter renderObject,
  ) => renderObject.onSize = onSize;
}

class RenderSizeReporter extends RenderProxyBox {
  RenderSizeReporter(this.onSize);
  ValueChanged<Size> onSize;
  Size? _last;

  @override
  void performLayout() {
    super.performLayout();
    if (size == _last) return;
    _last = size;
    // never setState during layout
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (attached) onSize(size);
    });
  }
}
