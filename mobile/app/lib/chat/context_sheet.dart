// The context sheet of a phone chat (opened from the header ring): what the window uses. The context in tokens, the plan
// limits with their resets, the session's cost, idle compaction, and three tiles (compact, clear, stats). A row the window
// does not report is left out. The pieces are the window sheet's (its tiles, its limit rows, its commands). Compact and
// clear send what the desktop's do, under the same conditions (web/src/controls/CompactClear.tsx): off while the agent
// works, absent when the agent cannot.
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
import '../usage/format.dart' show fmtTokens;
import '../usage/usage_screen.dart';
import '../comments/strings.g.dart';
import 'window_sheet.dart';
import 'window_tab.dart';

/// The ring's colour at [pct] of the context: primary, accent from 70 %, the danger colour from 90 %.
Color contextColor(NbColors c, num pct) => pct >= 90
    ? c.destructive
    : pct >= 70
    ? c.accent
    : c.primary;

/// A token count the short way (`68k`, `1.2M`); a whole unit loses its `.0`.
String _tokens(num n, String lang) =>
    fmtTokens(n, lang).replaceFirst(RegExp(r'\.0(?=\D|$)'), '');

Future<void> showContextSheet(BuildContext context, WindowTab tab) {
  final c = Theme.of(context).extension<NbColors>()!;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: c.popover,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => ContextSheet(tab: tab, outer: context),
  );
}

class ContextSheet extends StatelessWidget {
  const ContextSheet({super.key, required this.tab, required this.outer});
  final WindowTab tab;

  /// The chat's context: the stats screen opens through it after the sheet closes.
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
      final st = tab.stats?.stats;
      final ctx = st?.context;
      final limits = st?.limits;
      final five = limits?.fiveHour;
      final week = limits?.sevenDay;
      final cost = st?.cost;
      final idle = tab.idleCompact;
      final canCompact = caps?.compact ?? true;
      final label = TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w600,
        color: c.mutedFg,
      );
      const gap = SizedBox(height: 16);
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
                t.contextTitle,
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  color: c.foreground,
                ),
              ),
              if (ctx != null) ...[
                const SizedBox(height: 10),
                _Bar(
                  key: const ValueKey('context-bar'),
                  pct: ctx.pct,
                  color: contextColor(c, ctx.pct),
                ),
                const SizedBox(height: 6),
                Text(
                  t.contextTokens(
                    ctx.pct.clamp(0, 100).round().toString(),
                    _tokens(ctx.used, lang),
                    _tokens(ctx.max, lang),
                  ),
                  style: TextStyle(fontSize: 13, color: c.foreground),
                ),
              ],
              if (five != null || week != null) ...[
                gap,
                Text(t.limitsTitle, style: label),
                const SizedBox(height: 8),
                if (five != null) LimitRow(t.limit5h, five, lang),
                if (five != null && week != null) const SizedBox(height: 10),
                if (week != null) LimitRow(t.limitWeek, week, lang),
              ],
              if (cost != null) ...[
                gap,
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        t.costTitle,
                        style: TextStyle(fontSize: 13, color: c.foreground),
                      ),
                    ),
                    Text(
                      NumberFormat.simpleCurrency(
                        locale: lang,
                        name: 'USD',
                      ).format(cost),
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: c.foreground,
                      ),
                    ),
                  ],
                ),
              ],
              if (idle != null &&
                  (caps?.idleCompact ?? false) &&
                  canCompact) ...[
                gap,
                SwitchListTile(
                  key: const ValueKey('idle-compact'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    t.idleCompactTitle,
                    style: TextStyle(fontSize: 14, color: c.foreground),
                  ),
                  subtitle: Text(
                    idle.blocked ? t.idleCompactBlocked : t.idleCompactBody,
                    style: TextStyle(fontSize: 12, color: c.mutedFg),
                  ),
                  value: idle.on && !idle.blocked,
                  onChanged: open && !idle.blocked
                      ? (_) => tab.toggleIdleCompact()
                      : null,
                ),
              ],
              gap,
              Row(
                children: [
                  if (canCompact) ...[
                    Expanded(
                      child: SheetTile(
                        NbGlyph.compact,
                        t.tileCompact,
                        tooltip: webString('compactTip', lang),
                        enabled: open && !tab.busy,
                        onTap: () {
                          // the web shows no note for a refused Compact; the phone says why, as it does for Clear
                          final messenger = ScaffoldMessenger.maybeOf(outer);
                          Navigator.pop(context);
                          final why = runWindowCommand(
                            tab,
                            ClientMessageCommandName.compact,
                            lang,
                          );
                          if (why != null) {
                            messenger?.showSnackBar(
                              SnackBar(content: Text(why)),
                            );
                          }
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                  if (caps?.clear ?? true) ...[
                    Expanded(
                      child: SheetTile(
                        NbGlyph.clear,
                        t.tileClear,
                        tooltip: webString('clearTip', lang),
                        enabled: open && !tab.busy,
                        onTap: () => _clear(context),
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                  Expanded(
                    child: SheetTile(
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
    final why = runWindowCommand(tab, ClientMessageCommandName.clear, lang);
    if (why != null) {
      messenger?.showSnackBar(
        SnackBar(content: Text(webString('clearFail', lang) + why)),
      );
    }
  }
}

class _Bar extends StatelessWidget {
  const _Bar({super.key, required this.pct, required this.color});
  final num pct;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Container(
      height: 6,
      decoration: BoxDecoration(
        color: c.border,
        borderRadius: BorderRadius.circular(3),
      ),
      alignment: Alignment.centerLeft,
      // heightFactor: a childless DecoratedBox under the aligned (loose) height would be 0 px tall
      child: FractionallySizedBox(
        widthFactor: pct.clamp(0, 100) / 100,
        heightFactor: 1,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(3),
          ),
        ),
      ),
    );
  }
}
