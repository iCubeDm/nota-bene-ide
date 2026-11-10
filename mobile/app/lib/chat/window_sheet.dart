// The window sheet of a phone chat (opened from the header pill): what the window does: the session and its folder, the
// model and effort, one row per permission mode, and two tiles (clear, restart). What it uses (context, limits, cost,
// compact, stats) is the context sheet's. Each control sends what
// the desktop's sends, under the same conditions (web/src/controls/CompactClear.tsx, ModePill.tsx): clear is off while
// the agent works and absent when the agent cannot; restart is always there.
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/strings.g.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/nb_icon.dart';
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

/// Sends the window command [name] as the web's runCommand does (web/src/controls/slice.ts): refused while the agent
/// works or when the tab is not open. Null when it went, else the web's reason text in [lang] (`working`, `offline`).
String? runWindowCommand(
  WindowTab tab,
  ClientMessageCommandName name,
  String lang,
) {
  if (tab.busy) return webString('working', lang);
  if (!tab.send(ClientMessageCommand(name: name))) {
    return webString('offline', lang);
  }
  return null;
}

/// When a limit resets, for a person: `HH:mm` if it is today, else the short weekday and `HH:mm`; null when [iso] is
/// null or not a date.
String? resetWhen(String? iso, DateTime now, String locale) {
  final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
  if (d == null) return null;
  final today = d.year == now.year && d.month == now.month && d.day == now.day;
  return (today ? DateFormat.Hm(locale) : DateFormat('E HH:mm', locale)).format(
    d,
  );
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
      final modes = offeredModes(tab);
      final mode = shownMode(tab);
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
              if (modelSwitchable(tab)) ...[
                gap,
                _ModelRow(tab: tab),
              ] else if (tab.model ?? tab.feed.model case final model?) ...[
                gap,
                Text(t.windowSheetModel, style: label),
                const SizedBox(height: 4),
                Text(
                  model,
                  style: TextStyle(fontSize: 14, color: c.foreground),
                ),
              ],
              if (modes.length >= 2) ...[
                gap,
                Text(t.windowSheetMode, style: label),
                const SizedBox(height: 6),
                for (final m in modes)
                  _ModeRow(
                    name: modeLabel(tab, m, lang),
                    description: modeDescription(tab, m, lang),
                    selected: m == mode,
                    danger: modeWithoutPrompts(m),
                    onTap: open ? () => tab.setMode(m) : null,
                  ),
              ],
              gap,
              Row(
                children: [
                  if (caps?.clear ?? true) ...[
                    Expanded(
                      child: SheetTile(
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
                    child: SheetTile(
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

/// One permission mode: its name over its description in a row at least 48 tall, a check on the current one. A mode
/// that never asks (it is in the danger colour) says so by its colour before it is chosen.
class _ModeRow extends StatelessWidget {
  const _ModeRow({
    required this.name,
    required this.description,
    required this.selected,
    required this.danger,
    required this.onTap,
  });
  final String name, description;
  final bool selected, danger;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Semantics(
      selected: selected,
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: danger ? c.destructive : c.foreground,
                        ),
                      ),
                      Text(
                        description,
                        style: TextStyle(fontSize: 12, color: c.mutedFg),
                      ),
                    ],
                  ),
                ),
                if (selected)
                  Icon(
                    Icons.check,
                    size: 20,
                    color: danger ? c.destructive : c.primary,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
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
class LimitRow extends StatelessWidget {
  const LimitRow(this.label, this.limit, this.lang, {super.key});
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

class SheetTile extends StatelessWidget {
  const SheetTile(
    this.glyph,
    this.label, {
    required this.enabled,
    required this.onTap,
    this.tooltip,
    super.key,
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
