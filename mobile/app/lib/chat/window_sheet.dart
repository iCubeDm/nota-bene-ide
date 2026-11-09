// The window settings sheet of a phone chat (opened from the header pill): the session and its folder, the model and
// effort, the permission mode, the plan limits and four tiles (compact, clear, restart, stats). Each control sends what
// the desktop's sends, under the same conditions (web/src/controls/CompactClear.tsx, ModePill.tsx): compact and clear
// are off while the agent works and absent when the agent cannot; restart is always there.
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/strings.g.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../usage/usage_screen.dart';
import 'chat_header.dart';
import 'controls.dart';
import 'window_tab.dart';

Future<void> showWindowSheet(BuildContext context, WindowTab tab) {
  final c = Theme.of(context).extension<NbColors>()!;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: c.popover,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => WindowSheet(tab: tab, outer: context),
  );
}

/// When a limit resets, for a person: `HH:mm` if it is today, else the short weekday; null when [iso] is null or not a
/// date.
String? resetWhen(String? iso, DateTime now, String locale) {
  final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
  if (d == null) return null;
  final today = d.year == now.year && d.month == now.month && d.day == now.day;
  return (today ? DateFormat.Hm(locale) : DateFormat.E(locale)).format(d);
}

class WindowSheet extends StatelessWidget {
  const WindowSheet({super.key, required this.tab, required this.outer});
  final WindowTab tab;

  /// The chat's context: what the sheet opens after it closes (the stats screen, a note) goes through it.
  final BuildContext outer;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: tab,
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final c = Theme.of(context).extension<NbColors>()!;
      final lang = Localizations.localeOf(context).languageCode;
      final caps = tab.capabilities;
      final open = tab.state == TabState.open;
      final busy = tab.busy;
      final modes = [
        for (final m in caps?.modes ?? const <AgentMode>[])
          if (m != AgentMode.$unknown) m,
      ];
      final mode = tab.mode == AgentMode.$unknown ? null : tab.mode;
      final limits = tab.stats?.stats.limits;
      final five = limits?.fiveHour;
      final week = limits?.sevenDay;
      final label = TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w600,
        color: c.mutedFg,
      );
      final gap = const SizedBox(height: 16);
      return SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  decoration: BoxDecoration(
                    color: c.border,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Text(
                tab.feed.title ?? t.untitled,
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  color: c.foreground,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                tab.feed.root ?? tab.root,
                style: TextStyle(fontSize: 12, color: c.mutedFg),
              ),
              if (modelSwitchable(tab)) ...[gap, _ModelRow(tab: tab)],
              if (modes.isNotEmpty) ...[
                gap,
                Text(t.windowSheetMode, style: label),
                const SizedBox(height: 6),
                SegmentedButton<AgentMode>(
                  showSelectedIcon: false,
                  emptySelectionAllowed: true,
                  segments: [
                    for (final m in modes)
                      ButtonSegment(
                        value: m,
                        label: FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Text(modeLabel(tab, m, lang), maxLines: 1),
                        ),
                      ),
                  ],
                  selected: {?mode},
                  onSelectionChanged: open
                      ? (s) {
                          if (s.isNotEmpty) tab.setMode(s.first);
                        }
                      : null,
                ),
                if (mode != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    modeDescription(tab, mode, lang),
                    style: TextStyle(fontSize: 12, color: c.mutedFg),
                  ),
                ],
              ],
              if (five != null || week != null) ...[
                gap,
                Text(t.limitsTitle, style: label),
                const SizedBox(height: 8),
                if (five != null) _LimitRow(t.limit5h, five, lang),
                if (five != null && week != null) const SizedBox(height: 10),
                if (week != null) _LimitRow(t.limitWeek, week, lang),
              ],
              gap,
              Row(
                children: [
                  if (caps?.compact ?? true) ...[
                    Expanded(
                      child: _Tile(
                        NbGlyph.compact,
                        t.tileCompact,
                        tooltip: webString('compactTip', lang),
                        enabled: open && !busy,
                        onTap: () {
                          Navigator.pop(context);
                          tab.send(
                            const ClientMessageCommand(
                              name: ClientMessageCommandName.compact,
                            ),
                          );
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                  if (caps?.clear ?? true) ...[
                    Expanded(
                      child: _Tile(
                        NbGlyph.clear,
                        t.tileClear,
                        tooltip: webString('clearTip', lang),
                        enabled: open && !busy,
                        onTap: () => _clear(context),
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                  Expanded(
                    child: _Tile(
                      NbGlyph.restart,
                      t.tileRestart,
                      enabled: open,
                      onTap: () async {
                        if (await askRestart(context, tab) && context.mounted) {
                          Navigator.pop(context);
                        }
                      },
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _Tile(
                      NbGlyph.usage,
                      t.tileStats,
                      enabled: open && (caps?.usage ?? true),
                      onTap: () {
                        final nav = Navigator.of(outer);
                        Navigator.pop(context);
                        nav.push(
                          MaterialPageRoute<void>(
                            builder: (_) => UsageScreen(tab: tab),
                          ),
                        );
                      },
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    },
  );

  Future<void> _clear(BuildContext context) async {
    final t = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.maybeOf(outer);
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(webString('clearTitle', lang)),
        content: Text(webString('clearQ', lang)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: Text(t.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: Text(webString('clearBtn', lang)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    if (context.mounted) Navigator.pop(context);
    // the agent can turn busy while the dialog is open (another window sent): say so, as the desktop does
    final sent =
        !tab.busy &&
        tab.send(
          const ClientMessageCommand(name: ClientMessageCommandName.clear),
        );
    if (!sent) {
      messenger?.showSnackBar(SnackBar(content: Text(t.clearFailed)));
    }
  }
}

class _ModelRow extends StatelessWidget {
  const _ModelRow({required this.tab});
  final WindowTab tab;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final value = tab.model ?? tab.feed.model;
    final name =
        tab.models.where((m) => m.value == value).firstOrNull?.name ?? value;
    final effort = tab.effort;
    return Material(
      color: c.card,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => showModelSheet(context, tab),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      t.modelAndEffort,
                      style: TextStyle(fontSize: 12, color: c.mutedFg),
                    ),
                    if (name != null)
                      Text(
                        effort == null
                            ? name
                            : '$name · ${effortLabel(t, effort)}',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: c.foreground,
                        ),
                      ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, color: c.mutedFg),
            ],
          ),
        ),
      ),
    );
  }
}

/// One plan limit: its label and the percent (with the reset time when it has one), over a bar in the header's colours.
class _LimitRow extends StatelessWidget {
  const _LimitRow(this.label, this.limit, this.lang);
  final String label;
  final Limit limit;
  final String lang;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final pct = limit.utilization.clamp(0, 100).round();
    final when = resetWhen(limit.resetsAt, DateTime.now(), lang);
    final hot = meterLevel(limit.utilization) == 2;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: TextStyle(fontSize: 13, color: c.foreground),
              ),
            ),
            Text(
              when == null ? '$pct%' : t.limitResets(pct, when),
              style: TextStyle(
                fontSize: 12,
                color: hot ? c.destructive : c.mutedFg,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          height: 6,
          decoration: BoxDecoration(
            color: c.border,
            borderRadius: BorderRadius.circular(3),
          ),
          alignment: Alignment.centerLeft,
          child: FractionallySizedBox(
            widthFactor: pct / 100,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: meterFill(c, limit.utilization),
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile(
    this.glyph,
    this.label, {
    required this.enabled,
    required this.onTap,
    this.tooltip,
  });
  final NbGlyph glyph;
  final String label;
  final bool enabled;
  final VoidCallback onTap;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final tile = Opacity(
      opacity: enabled ? 1 : 0.4,
      child: Material(
        color: c.card,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                NbIcon(glyph, size: 22, color: c.foreground),
                const SizedBox(height: 6),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, color: c.mutedFg),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    return tooltip == null ? tile : Tooltip(message: tooltip!, child: tile);
  }
}
