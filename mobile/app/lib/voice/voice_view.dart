// The voice as Telegram draws it: a round play button, the 48-bar wave (the played part in the primary colour, tap or
// drag to seek) and under it the length, or the position while it plays. Used by the bubbles, the clips and the
// recorder's preview.
import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'player.dart';

String clock(Duration d) =>
    '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

/// The bars: 2 px wide with 1 px gaps, rounded, [done] (0..1) of them painted in [played].
class WavePainter extends CustomPainter {
  WavePainter(this.wave, this.done, this.played, this.rest);
  final List<num> wave;
  final double done;
  final Color played, rest;

  static const bar = 2.0, gap = 1.0;

  /// The width of [bars] bars.
  static double widthOf(int bars) => bars * (bar + gap) - gap;

  @override
  void paint(Canvas canvas, Size size) {
    for (var i = 0; i < wave.length; i++) {
      final x = i * (bar + gap);
      final h = 2 + (size.height - 2) * (wave[i].clamp(0, 31) / 31);
      final on = (x + bar / 2) / size.width <= done;
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, (size.height - h) / 2, bar, h),
          const Radius.circular(1),
        ),
        Paint()..color = on ? played : rest,
      );
    }
  }

  @override
  bool shouldRepaint(WavePainter o) =>
      o.done != done || o.wave != wave || o.played != played || o.rest != rest;
}

class VoiceView extends StatelessWidget {
  const VoiceView({
    super.key,
    required this.id,
    required this.ms,
    required this.wave,
    required this.load,
    this.player,
    this.trailing,
  });

  /// What the player knows it by.
  final String id;
  final int ms;
  final List<num> wave;
  final LoadVoice load;
  final VoicePlayer? player;

  /// At the right of the wave (the transcript toggle).
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final p = player ?? VoicePlayer.shared;
    return ListenableBuilder(
      listenable: p,
      builder: (context, _) {
        final mine = p.isCurrent(id);
        final playing = mine && p.playing;
        final length = Duration(milliseconds: ms);
        final shown = mine ? p.position : length;
        final done = !mine || ms <= 0
            ? 0.0
            : (p.position.inMilliseconds / ms).clamp(0.0, 1.0);
        final width = WavePainter.widthOf(wave.length);
        void seekTo(double dx) => p.seek(
          id,
          load,
          Duration(milliseconds: (ms * (dx / width).clamp(0.0, 1.0)).round()),
        );
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(
              tooltip: playing ? t.voicePause : t.voicePlay,
              onPressed: () => p.toggle(id, load),
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
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTapUp: (d) => seekTo(d.localPosition.dx),
                  onHorizontalDragUpdate: (d) => seekTo(d.localPosition.dx),
                  child: SizedBox(
                    width: width,
                    height: 28,
                    child: CustomPaint(
                      key: const ValueKey('wave'),
                      painter: WavePainter(
                        wave,
                        done,
                        c.primary,
                        c.mutedFg.withValues(alpha: .5),
                      ),
                    ),
                  ),
                ),
                Text(
                  clock(shown),
                  style: TextStyle(
                    color: c.mutedFg,
                    fontSize: 12,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
            if (trailing != null) ...[const SizedBox(width: 4), trailing!],
          ],
        );
      },
    );
  }
}
