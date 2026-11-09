// What the field shows while a voice session runs: the time, the level, and the way out.
import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'voice_button.dart';

class RecordBar extends StatelessWidget {
  const RecordBar({super.key, required this.state, required this.meter});
  final VoiceState state;
  final VoiceMeter meter;

  // the host stops a recording at 120 s; the timer warns from 110
  static const warnAt = Duration(seconds: 110);

  static String format(Duration d) =>
      '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    return ListenableBuilder(
      listenable: meter,
      builder: (context, _) {
        final working = state == VoiceState.working;
        final locked = state == VoiceState.locked;
        return Row(
          children: [
            const SizedBox(width: 16),
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: working ? c.mutedFg : c.destructive,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              format(meter.elapsed),
              key: const Key('timer'),
              style: TextStyle(
                fontFeatures: const [FontFeature.tabularFigures()],
                color: meter.elapsed >= warnAt ? c.accent : null,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: working
                  ? Text(
                      t.voiceTranscribing,
                      style: TextStyle(color: c.mutedFg),
                    )
                  : locked
                  ? SizedBox(
                      height: 24,
                      child: CustomPaint(
                        painter: _Wave(meter.levels, c.accent),
                        size: Size.infinite,
                      ),
                    )
                  : Text(
                      '◀ ${t.voiceSlideCancel}',
                      style: TextStyle(color: c.mutedFg),
                      overflow: TextOverflow.ellipsis,
                    ),
            ),
            if (locked) ...[
              TextButton(
                onPressed: VoiceButton.cancelRunning,
                child: Text(t.voiceCancel),
              ),
              IconButton(
                tooltip: t.voiceStop,
                icon: const NbIcon(NbGlyph.stop),
                style: IconButton.styleFrom(
                  backgroundColor: c.destructive,
                  foregroundColor: c.background,
                ),
                onPressed: VoiceButton.stopRunning,
              ),
            ],
            if (working)
              const Padding(
                padding: EdgeInsets.all(14),
                child: SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _Wave extends CustomPainter {
  _Wave(this.levels, this.color);
  final List<double> levels;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = color
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    const step = 5.0;
    final n = (size.width / step).floor();
    for (var i = 0; i < n && i < levels.length; i++) {
      // newest on the right
      final v = levels[levels.length - 1 - i];
      final h = 3 + v * (size.height - 3);
      final x = size.width - i * step - 1;
      canvas.drawLine(
        Offset(x, (size.height - h) / 2),
        Offset(x, (size.height + h) / 2),
        p,
      );
    }
  }

  @override
  bool shouldRepaint(_Wave old) => true;
}
