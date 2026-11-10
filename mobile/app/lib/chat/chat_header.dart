// The floating header of a phone chat: a back button, a pill with the session (avatar, name; under it what the session is
// doing) and the context ring. It floats over the feed, which scrolls under it.
import 'dart:async';

import 'package:flutter/material.dart';

import 'package:nb_protocol/nb_protocol.dart' show CapabilitiesProvider;

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../hosts/project_icon.dart';
import 'context_sheet.dart' show contextColor;
import 'session_state.dart';
import 'window_tab.dart';

/// The avatar letter of a provider: `claude` C, `codex` X, `omp` O, else the first letter or `?`.
String providerLetter(String? provider) => switch (provider) {
  'claude' => 'C',
  'codex' => 'X',
  'omp' => 'O',
  null || '' => '?',
  final p => p.substring(0, 1).toUpperCase(),
};

/// The web's level of a limit meter (web/src/stats/Meters.tsx): 0 below 60%, 1 (warn) from 60%, 2 (hot) from 85%.
int meterLevel(num pct) => pct >= 85
    ? 2
    : pct >= 60
    ? 1
    : 0;

/// The fill of a limit meter at [utilization]: primary, accent (warn) or destructive (hot), by [meterLevel].
Color meterFill(NbColors c, num utilization) =>
    [c.primary, c.accent, c.destructive][meterLevel(utilization)];

class ChatHeader extends StatelessWidget {
  const ChatHeader({
    super.key,
    required this.tab,
    this.onTapTitle,
    this.onTapRing,
    this.actions = const [],
  });

  final WindowTab tab;
  final VoidCallback? onTapTitle;

  /// Tapping the context ring (the context sheet); null leaves the ring inert.
  final VoidCallback? onTapRing;
  final List<Widget> actions;

  /// The height of the header with its margins (the feed keeps this much clear at its top).
  static const extent = 56.0;
  static const _size = 40.0;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final f = tab.feed;
    final ctx = tab.stats?.stats.context;
    // without a live link the avatar and the ring dim; the ring keeps the last value
    final live = tab.state == TabState.open;
    final shape = StadiumBorder(side: BorderSide(color: c.border));
    final fill = c.popover.withValues(alpha: 0.92);
    final content = MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.3,
      child: Row(
        children: [
          const SizedBox(width: 6),
          Opacity(
            opacity: live ? 1 : 0.5,
            child: SizedBox(
              width: 28,
              height: 28,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  ListenableBuilder(
                    listenable: tab.link,
                    builder: (_, _) => ProjectIconAvatar(
                      link: tab.link,
                      port: tab.port,
                      icon: tab.link.windows
                          .where((w) => w.port == tab.port)
                          .firstOrNull
                          ?.icon,
                      size: 28,
                      semanticLabel: providerName(
                        switch (tab.capabilities?.provider) {
                          CapabilitiesProvider.$unknown || null => null,
                          final p => p.name,
                        },
                      ),
                      badge: ProviderBadge(
                        letter: providerLetter(
                          switch (tab.capabilities?.provider) {
                            CapabilitiesProvider.$unknown || null => null,
                            final p => p.name,
                          },
                        ),
                        size: 13,
                        fill: c.muted,
                        fg: c.foreground,
                        ring: c.popover,
                      ),
                      fallback: Container(
                        width: 28,
                        height: 28,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: c.muted,
                          shape: BoxShape.circle,
                        ),
                        child: Text(
                          providerLetter(switch (tab.capabilities?.provider) {
                            CapabilitiesProvider.$unknown || null => null,
                            final p => p.name,
                          }),
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: c.foreground,
                          ),
                        ),
                      ),
                    ),
                  ),
                  if (live && tab.busy)
                    Positioned(
                      right: -1,
                      bottom: -1,
                      child: Container(
                        key: const ValueKey('busy-dot'),
                        width: 9,
                        height: 9,
                        decoration: BoxDecoration(
                          color: c.accent,
                          shape: BoxShape.circle,
                          border: Border.all(color: c.popover, width: 1.5),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  f.title ?? t.untitled,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    height: 1.15,
                    color: c.foreground,
                  ),
                ),
                _StateLine(tab: tab),
              ],
            ),
          ),
          const SizedBox(width: 12),
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      child: SizedBox(
        height: _size,
        child: Row(
          children: [
            Material(
              color: fill,
              shape: const CircleBorder(),
              child: Tooltip(
                message: MaterialLocalizations.of(context).backButtonTooltip,
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: () => Navigator.of(context).maybePop(),
                  child: Container(
                    width: _size,
                    height: _size,
                    alignment: Alignment.center,
                    decoration: ShapeDecoration(
                      shape: CircleBorder(side: BorderSide(color: c.border)),
                    ),
                    child: NbIcon(NbGlyph.back, color: c.foreground),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Material(
                color: fill,
                shape: shape,
                clipBehavior: Clip.antiAlias,
                child: onTapTitle == null
                    ? content
                    : InkWell(onTap: onTapTitle, child: content),
              ),
            ),
            if (tab.capabilities != null || ctx != null) ...[
              const SizedBox(width: 8),
              ContextRing(
                pct: ctx?.pct,
                dimmed: !live,
                onTap: onTapRing,
                fill: fill,
              ),
            ],
            if (actions.isNotEmpty) ...[
              const SizedBox(width: 8),
              Material(
                color: fill,
                shape: shape,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: _size),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: actions,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The pill's second line. It ticks once a second while the agent works, for the elapsed time.
class _StateLine extends StatefulWidget {
  const _StateLine({required this.tab});
  final WindowTab tab;

  @override
  State<_StateLine> createState() => _StateLineState();
}

class _StateLineState extends State<_StateLine> {
  Timer? _tick;
  Duration? _every;

  @override
  void initState() {
    super.initState();
    widget.tab.link.addListener(_relink);
  }

  @override
  void didUpdateWidget(_StateLine old) {
    super.didUpdateWidget(old);
    if (old.tab.link != widget.tab.link) {
      old.tab.link.removeListener(_relink);
      widget.tab.link.addListener(_relink);
    }
  }

  // the link reconnecting or giving up changes the line (connecting…, seen N min ago) without the tab saying anything
  void _relink() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.tab.link.removeListener(_relink);
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tab = widget.tab;
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final locale = Localizations.localeOf(context).languageCode;
    // a second for the elapsed time of a turn, half a minute for "seen N min ago"
    final every = tab.state == TabState.open && tab.busy
        ? const Duration(seconds: 1)
        : tab.state == TabState.offline
        ? const Duration(seconds: 30)
        : null;
    if (every != _every) {
      _tick?.cancel();
      _every = every;
      _tick = every == null
          ? null
          : Timer.periodic(every, (_) {
              if (mounted) setState(() {});
            });
    }
    return Text(
      sessionLine(t, tab, tab.clock(), locale),
      key: const ValueKey('state-line'),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        fontSize: 11,
        height: 1.15,
        color: sessionActive(tab) ? c.accent : c.mutedFg,
      ),
    );
  }
}

/// The context in use as a 40 dp ring with its percent inside: primary, accent from 70 %, the danger colour from 90 %.
/// Dimmed (and still showing the last value) without a live link.
class ContextRing extends StatelessWidget {
  const ContextRing({
    super.key,
    required this.pct,
    required this.dimmed,
    required this.onTap,
    required this.fill,
  });

  /// The context in use in percent; null when the window reports none (the ring is then empty).
  final num? pct;
  final bool dimmed;
  final VoidCallback? onTap;
  final Color fill;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final shown = pct?.clamp(0, 100).round();
    return Semantics(
      container: true,
      button: onTap != null,
      onTap: onTap,
      label: shown == null ? t.contextTitle : '${t.contextTitle} $shown%',
      child: ExcludeSemantics(
        child: Tooltip(
          message: t.contextTitle,
          child: Opacity(
            opacity: dimmed ? 0.5 : 1,
            child: Material(
              color: fill,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: onTap,
                child: SizedBox.square(
                  dimension: ChatHeader._size,
                  child: CustomPaint(
                    key: const ValueKey('context-ring'),
                    painter: _RingPainter(
                      fraction: (shown ?? 0) / 100,
                      color: contextColor(c, pct ?? 0),
                      track: c.border,
                    ),
                    child: Center(
                      child: Text(
                        shown == null ? '–' : '$shown',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: c.foreground,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  const _RingPainter({
    required this.fraction,
    required this.color,
    required this.track,
  });
  final double fraction;
  final Color color, track;

  @override
  void paint(Canvas canvas, Size size) {
    const w = 3.0;
    final rect = (Offset.zero & size).deflate(w / 2 + 1);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = w
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(rect, 0, 6.2832, false, p..color = track);
    if (fraction > 0) {
      canvas.drawArc(rect, -1.5708, 6.2832 * fraction, false, p..color = color);
    }
  }

  @override
  bool shouldRepaint(_RingPainter o) =>
      o.fraction != fraction || o.color != color || o.track != track;
}
