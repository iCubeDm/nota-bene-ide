// The blur under floating chrome (the header and tabs on top, the message field below), as in Telegram: what scrolls
// under it is blurred and dimmed, strongest at the screen's edge and fading to clear toward the feed, no hard edge.
// One backdrop filter per band, shared through the nearest BackdropGroup.
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../theme.dart';

/// How far above the field's top the bottom blur begins to fade in.
const blurFade = 24.0;

/// The blurred band: [top] puts the strong end at its top edge, else at its bottom edge. The blur is stepped, strips of
/// less and less sigma toward the clear end (a backdrop filter inside a mask would read an empty layer and blur nothing),
/// and the dimming over it is a gradient. The top band is all fade; the bottom's clear end is [fade] long. Passes touches
/// through: the solid parts of the chrome take their own.
class BlurBand extends StatelessWidget {
  const BlurBand({super.key, required this.top, this.fade});
  final bool top;
  final double? fade;

  Widget _strip(double sigma) => ClipRect(
    child: BackdropFilter.grouped(
      filter: ImageFilter.blur(sigmaX: sigma, sigmaY: sigma),
      child: const SizedBox.expand(),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return IgnorePointer(
      child: ExcludeSemantics(
        child: LayoutBuilder(
          builder: (context, box) {
            // the dimming along the band: 1 at the strong end, 0 at the clear one
            final ramp = fade == null || box.maxHeight <= 0
                ? 0.6
                : (fade! / box.maxHeight).clamp(0.0, 1.0);
            final alphas = top ? [1.0, 1.0, 0.0] : [0.0, 1.0, 1.0];
            final stops = top ? [0.0, 1 - ramp, 1.0] : [0.0, ramp, 1.0];
            final half = (fade ?? 0) / 2;
            return Stack(
              children: [
                // the last stretch before the clear end is not blurred at all
                Positioned.fill(
                  child: top
                      ? Column(
                          children: [
                            Expanded(flex: 4, child: _strip(12)),
                            Expanded(flex: 3, child: _strip(5)),
                            const Spacer(flex: 3),
                          ],
                        )
                      : Column(
                          children: [
                            SizedBox(height: half),
                            SizedBox(height: half, child: _strip(4)),
                            Expanded(child: _strip(12)),
                          ],
                        ),
                ),
                Positioned.fill(
                  child: ShaderMask(
                    blendMode: BlendMode.dstIn,
                    shaderCallback: (r) => LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [
                        for (final a in alphas)
                          Colors.black.withValues(alpha: a),
                      ],
                      stops: stops,
                    ).createShader(r),
                    child: ColoredBox(
                      color: c.background.withValues(alpha: 0.55),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// The room the floating chrome takes at the bottom of a feed (the field, its strip, the nav bar and the fade above
/// them), for what scrolls into view in it.
class BandInset extends InheritedNotifier<ValueNotifier<double>> {
  const BandInset({
    super.key,
    required ValueNotifier<double> inset,
    required super.child,
  }) : super(notifier: inset);

  static double of(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<BandInset>()
          ?.notifier
          ?.value ??
      0;
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
