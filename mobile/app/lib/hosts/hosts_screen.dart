import 'package:flutter/material.dart';
import 'package:nb_channel/nb_channel.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'host_link.dart';

String folderOf(String root) {
  final parts = root.split(RegExp(r'[\\/]')).where((p) => p.isNotEmpty);
  return parts.isEmpty ? root : parts.last;
}

String ago(AppLocalizations t, Duration d) {
  if (d.inMinutes < 1) return t.justNow;
  if (d.inHours < 1) return t.minutesAgo(d.inMinutes);
  if (d.inDays < 1) return t.hoursAgo(d.inHours);
  return t.daysAgo(d.inDays);
}

/// One group per paired host, its windows as rows.
class HostsList extends StatelessWidget {
  const HostsList({
    super.key,
    required this.links,
    required this.onOpen,
    required this.onForget,
    this.clock = DateTime.now,
  });

  final Iterable<HostLink> links;
  final void Function(HostLink link, HostWindow w) onOpen;
  final void Function(HostLink link) onForget;
  final DateTime Function() clock;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final rows = <Widget>[];
    for (final l in links) {
      final (dot, status) = switch (l.state) {
        LinkState.online => (c.success, null),
        LinkState.connecting => (c.mutedFg, t.connecting),
        LinkState.offline => (
          c.mutedFg,
          l.lastSeen == null
              ? t.offline
              : t.offlineSeen(ago(t, clock().difference(l.lastSeen!))),
        ),
        LinkState.unpaired => (c.destructive, t.unpaired),
      };
      rows.add(
        ListTile(
          dense: true,
          leading: Icon(Icons.circle, size: 10, color: dot),
          title: Text(
            l.host.label,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: status == null ? null : Text(status),
          trailing: l.state == LinkState.unpaired
              ? TextButton(onPressed: () => onForget(l), child: Text(t.forget))
              : null,
        ),
      );
      if (l.state != LinkState.unpaired) {
        if (l.windows.isEmpty && l.state == LinkState.online) {
          rows.add(
            Padding(
              padding: const EdgeInsets.fromLTRB(56, 0, 16, 12),
              child: Text(t.noWindows, style: TextStyle(color: c.mutedFg)),
            ),
          );
        }
        for (final w in l.windows) {
          rows.add(
            ListTile(
              contentPadding: const EdgeInsets.only(left: 56, right: 16),
              title: Text(folderOf(w.root)),
              subtitle: Text(
                [
                  w.title ?? t.untitled,
                  w.provider,
                  if (w.model != null) w.model!,
                ].join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              trailing: w.busy
                  ? Icon(Icons.circle, size: 8, color: c.accent)
                  : null,
              enabled: l.state == LinkState.online,
              onTap: () => onOpen(l, w),
            ),
          );
        }
      }
      rows.add(Divider(color: c.borderSoft, height: 1));
    }
    return ListView(children: rows);
  }
}
