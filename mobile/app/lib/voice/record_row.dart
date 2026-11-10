// What takes the message field's place while a voice is recorded: the blinking red dot, the timer (`0:03,4`, tenths)
// and "‹ Slide to cancel", which follows the finger and fades as it nears the cancel distance. Locked, the middle is
// CANCEL; in the preview it is Delete and the recording's player.
import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import 'record_session.dart';
import 'voice_view.dart';
import 'wav.dart' show wavMs;

/// `0:03,4`: minutes, seconds and tenths.
String timer(Duration d) =>
    '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')},${(d.inMilliseconds ~/ 100) % 10}';

class RecordRow extends StatelessWidget {
  const RecordRow({super.key, required this.session});
  final RecordSession session;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: session,
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      switch (session.phase) {
        case RecordPhase.idle:
          return const SizedBox.shrink();
        case RecordPhase.preview:
          final wav = session.wav!;
          return Row(
            children: [
              IconButton(
                tooltip: t.voiceDelete,
                icon: const NbIcon(NbGlyph.trash),
                color: c.destructive,
                onPressed: session.cancel,
              ),
              Flexible(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: VoiceView(
                    id: session.previewId,
                    ms: wavMs(wav),
                    wave: session.wave,
                    load: () async => wav,
                  ),
                ),
              ),
            ],
          );
        case RecordPhase.recording || RecordPhase.locked:
          final locked = session.phase == RecordPhase.locked;
          final dx = session.drag.dx;
          return SizedBox(
            height: 48,
            child: Row(
              children: [
                const SizedBox(width: 16),
                // blinks every 500 ms
                AnimatedOpacity(
                  opacity: (session.elapsed.inMilliseconds ~/ 500).isEven
                      ? 1
                      : .2,
                  duration: const Duration(milliseconds: 150),
                  child: Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: c.destructive,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  timer(session.elapsed),
                  key: const ValueKey('timer'),
                  style: TextStyle(
                    fontFeatures: const [FontFeature.tabularFigures()],
                    color: session.elapsed >= RecordSession.warnAt
                        ? c.accent
                        : null,
                  ),
                ),
                Expanded(
                  child: Center(
                    child: locked
                        ? TextButton(
                            onPressed: session.cancel,
                            style: TextButton.styleFrom(
                              foregroundColor: c.accent,
                            ),
                            child: Text(
                              t.voiceCancel.toUpperCase(),
                              maxLines: 1,
                              overflow: TextOverflow.fade,
                              softWrap: false,
                            ),
                          )
                        : Transform.translate(
                            offset: Offset(dx, 0),
                            child: Opacity(
                              key: const ValueKey('slide'),
                              opacity: (1 - dx.abs() / RecordSession.cancelAt)
                                  .clamp(0.0, 1.0),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  NbIcon(
                                    NbGlyph.chevronLeft,
                                    size: 16,
                                    color: c.mutedFg,
                                  ),
                                  // a narrow phone or a long translation: the label gives way, the row never overflows
                                  Flexible(
                                    child: Text(
                                      t.voiceSlideCancel,
                                      maxLines: 1,
                                      overflow: TextOverflow.fade,
                                      softWrap: false,
                                      style: TextStyle(color: c.mutedFg),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                  ),
                ),
              ],
            ),
          );
      }
    },
  );
}
