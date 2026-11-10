// What covers the feed when the window is not simply there. The one-tab rule of the window server: another tab owns the
// window (occupied), or took it from this one (taken); work here takes it over either way, and the desktop tab then
// offers the same. A window that closed or restarted (gone): a spinner over the dimmed feed, and after a while a way to
// try again. The composer is not covered: the draft stays.
import 'dart:async';

import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'window_tab.dart';

/// How long a gone window is waited for before the way to try again appears.
const goneRetryAfter = Duration(seconds: 30);

class OneTabOverlay extends StatefulWidget {
  const OneTabOverlay({super.key, required this.tab});
  final WindowTab tab;

  @override
  State<OneTabOverlay> createState() => _OneTabOverlayState();
}

class _OneTabOverlayState extends State<OneTabOverlay> {
  Timer? _timer;
  bool _late = false;

  @override
  void initState() {
    super.initState();
    widget.tab.addListener(_changed);
    _changed();
  }

  @override
  void dispose() {
    widget.tab.removeListener(_changed);
    _timer?.cancel();
    super.dispose();
  }

  void _changed() {
    final gone = widget.tab.state == TabState.gone;
    if (gone && _timer == null && !_late) {
      _timer = Timer(goneRetryAfter, () {
        _timer = null;
        if (mounted) setState(() => _late = true);
      });
    } else if (!gone) {
      _timer?.cancel();
      _timer = null;
      // read by the build that follows this change
      _late = false;
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.tab,
    builder: (context, _) {
      final tab = widget.tab;
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      if (tab.state == TabState.gone) {
        return Positioned.fill(
          child: ColoredBox(
            color: c.background.withValues(alpha: 0.7),
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const SizedBox.square(
                      dimension: 28,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      t.windowGoneTitle,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: c.foreground,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      t.windowGoneBody,
                      textAlign: TextAlign.center,
                      style: TextStyle(color: c.mutedFg),
                    ),
                    if (_late) ...[
                      const SizedBox(height: 16),
                      FilledButton(onPressed: tab.reopen, child: Text(t.retry)),
                    ],
                  ],
                ),
              ),
            ),
          ),
        );
      }
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
                  FilledButton(
                    onPressed: tab.takeOver,
                    child: Text(t.workHere),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}
