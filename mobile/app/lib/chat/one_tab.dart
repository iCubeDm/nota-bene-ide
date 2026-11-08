// The one-tab rule of the window server: another tab owns the window (occupied), or took it from this one (taken).
// Work here takes it over either way; the desktop tab then offers the same.
import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'window_tab.dart';

class OneTabOverlay extends StatelessWidget {
  const OneTabOverlay({super.key, required this.tab});
  final WindowTab tab;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final text = switch (tab.state) {
      TabState.occupied => t.occupiedTitle,
      TabState.taken => t.takenTitle,
      _ => null,
    };
    if (text == null) return const SizedBox.shrink();
    return Positioned.fill(
      child: ColoredBox(
        color: c.background.withValues(alpha: 0.92),
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(text, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton(onPressed: tab.takeOver, child: Text(t.workHere)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
