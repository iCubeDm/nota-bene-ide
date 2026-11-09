// The floating header of a phone chat: a back button, a pill with the session (avatar, title, model, limit meters)
// and a round button for the actions. It floats over the feed, which scrolls under it.
import 'package:flutter/material.dart';

import 'package:nb_protocol/nb_protocol.dart' show CapabilitiesProvider;

import '../comments/strings.g.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
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
    this.actions = const [],
  });

  final WindowTab tab;
  final VoidCallback? onTapTitle;
  final List<Widget> actions;

  /// The height of the header with its margins (the feed keeps this much clear at its top).
  static const extent = 56.0;
  static const _size = 40.0;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final f = tab.feed;
    final model = tab.model ?? f.model;
    final limits = tab.stats?.stats.limits;
    final mode = shownMode(tab);
    final shape = StadiumBorder(side: BorderSide(color: c.border));
    final fill = c.popover.withValues(alpha: 0.92);
    final content = MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.3,
      child: Row(
        children: [
          const SizedBox(width: 6),
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: c.muted, shape: BoxShape.circle),
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
                LayoutBuilder(
                  builder: (context, box) => Row(
                    children: [
                      if (model != null)
                        Flexible(
                          child: Text(
                            model,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11,
                              height: 1.15,
                              color: c.mutedFg,
                            ),
                          ),
                        ),
                      if (mode != null)
                        Flexible(
                          child: Padding(
                            padding: EdgeInsets.only(
                              left: model != null ? 6 : 0,
                            ),
                            child: Text(
                              modeLabel(tab, mode, lang),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 11,
                                height: 1.15,
                                color: c.accent,
                              ),
                            ),
                          ),
                        ),
                      // the meters keep their room, the model ellipsizes; too narrow even then, they scale down
                      if (limits?.fiveHour != null || limits?.sevenDay != null)
                        ConstrainedBox(
                          constraints: BoxConstraints(maxWidth: box.maxWidth),
                          child: FittedBox(
                            fit: BoxFit.scaleDown,
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (limits?.fiveHour != null)
                                  _Meter(
                                    'h5',
                                    webString('h5', lang),
                                    limits!.fiveHour!.utilization,
                                    lead: model != null || mode != null,
                                  ),
                                if (limits?.sevenDay != null)
                                  _Meter(
                                    'week',
                                    webString('week', lang),
                                    limits!.sevenDay!.utilization,
                                    lead:
                                        model != null ||
                                        mode != null ||
                                        limits.fiveHour != null,
                                  ),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
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

/// One limit: a label, a 22x4 bar and the percent, as the web's meters (utilization is already 0 to 100).
class _Meter extends StatelessWidget {
  const _Meter(this.id, this.label, this.utilization, {required this.lead});
  final String id;
  final String label;
  final num utilization;
  final bool lead;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final pct = utilization.clamp(0, 100).round();
    final level = meterLevel(utilization);
    final fill = meterFill(c, utilization);
    final style = TextStyle(
      fontSize: 11,
      height: 1.15,
      color: level == 2 ? c.destructive : c.mutedFg,
    );
    return Semantics(
      container: true,
      label: '$label $pct%',
      child: ExcludeSemantics(
        child: Padding(
          padding: EdgeInsets.only(left: lead ? 8 : 0),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label, style: style),
              const SizedBox(width: 3),
              Container(
                width: 22,
                height: 4,
                decoration: BoxDecoration(
                  color: c.border,
                  borderRadius: BorderRadius.circular(2),
                ),
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                  widthFactor: pct / 100,
                  child: DecoratedBox(
                    key: ValueKey('fill-$id'),
                    decoration: BoxDecoration(
                      color: fill,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 3),
              Text('$pct%', style: style),
            ],
          ),
        ),
      ),
    );
  }
}
