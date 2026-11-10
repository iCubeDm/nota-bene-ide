import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:nb_channel/nb_channel.dart';

import '../l10n/app_localizations.dart';
import '../chat/chat_header.dart' show providerLetter;
import '../store/seen.dart';
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

/// The time of a row: `HH:mm` today, the short weekday within the last week, else day and month (`d.MM`).
String rowTime(DateTime at, DateTime now, String locale) {
  final day = DateTime(at.year, at.month, at.day);
  final today = DateTime(now.year, now.month, now.day);
  final days = today.difference(day).inDays;
  if (days == 0) return DateFormat.Hm(locale).format(at);
  if (days > 0 && days < 7) return DateFormat.E(locale).format(at);
  return DateFormat('d.MM', locale).format(at);
}

/// One group per paired host, its windows as rows.
class HostsList extends StatelessWidget {
  const HostsList({
    super.key,
    required this.links,
    required this.seen,
    required this.onOpen,
    required this.onForget,
    this.onRename,
    this.onRefresh,
    this.clock = DateTime.now,
  });

  final Iterable<HostLink> links;
  final Seen seen;
  final void Function(HostLink link, HostWindow w) onOpen;
  final void Function(HostLink link) onForget;

  /// Long-press on a host row.
  final void Function(HostLink link)? onRename;

  /// Pull to refresh; the indicator stays until this completes.
  final Future<void> Function()? onRefresh;
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
          onLongPress: onRename == null ? null : () => onRename!(l),
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
        if (l.windows.isEmpty && l.state == LinkState.connecting) {
          rows.add(const _SkeletonRow());
          rows.add(const _SkeletonRow());
        }
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
            _SessionRow(
              window: w,
              online: l.state == LinkState.online,
              unread: seen.unread(l.host.id, w),
              now: clock(),
              onOpen: () => onOpen(l, w),
              onMarkRead: () {
                final session = w.session, replies = w.replies;
                if (session != null && replies != null) {
                  seen.see(l.host.id, session, replies);
                }
              },
            ),
          );
        }
      }
      rows.add(Divider(color: c.borderSoft, height: 1));
    }
    final list = ListView(
      // an empty or short list can still be pulled
      physics: const AlwaysScrollableScrollPhysics(),
      children: rows,
    );
    final refresh = onRefresh;
    return refresh == null
        ? list
        : RefreshIndicator(onRefresh: refresh, child: list);
  }
}

/// A grey placeholder for a window of a host that is still connecting.
class _SkeletonRow extends StatelessWidget {
  const _SkeletonRow();

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    Widget bar(double factor) => FractionallySizedBox(
      widthFactor: factor,
      alignment: Alignment.centerLeft,
      child: Container(
        height: 12,
        decoration: BoxDecoration(
          color: c.muted,
          borderRadius: BorderRadius.circular(6),
        ),
      ),
    );
    return Padding(
      key: const ValueKey('skeleton-row'),
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      child: Row(
        children: [
          Container(
            width: 54,
            height: 54,
            decoration: BoxDecoration(color: c.muted, shape: BoxShape.circle),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              children: [bar(0.7), const SizedBox(height: 10), bar(0.45)],
            ),
          ),
        ],
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    required this.window,
    required this.online,
    required this.unread,
    required this.now,
    required this.onOpen,
    required this.onMarkRead,
  });

  final HostWindow window;
  final bool online;
  final int unread;
  final DateTime now;
  final VoidCallback onOpen, onMarkRead;

  Future<void> _menu(BuildContext context) {
    final t = AppLocalizations.of(context);
    return showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (online)
              ListTile(
                title: Text(t.openSession),
                onTap: () {
                  Navigator.pop(sheet);
                  onOpen();
                },
              ),
            ListTile(
              title: Text(t.markRead),
              onTap: () {
                Navigator.pop(sheet);
                onMarkRead();
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final w = window;
    final last = w.last;
    final folder = folderOf(w.root);
    return Opacity(
      key: ValueKey('dim-${w.port}'),
      opacity: online ? 1 : 0.5,
      child: InkWell(
        onTap: online ? onOpen : null,
        onLongPress: () => _menu(context),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
          child: Row(
            children: [
              SizedBox.square(
                dimension: 54,
                child: Stack(
                  children: [
                    Container(
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: c.muted,
                        shape: BoxShape.circle,
                      ),
                      child: Text(
                        providerLetter(w.provider),
                        style: TextStyle(
                          fontSize: 21,
                          fontWeight: FontWeight.w600,
                          color: c.foreground,
                        ),
                      ),
                    ),
                    if (w.busy)
                      Positioned(
                        right: 0,
                        bottom: 0,
                        child: Container(
                          width: 14,
                          height: 14,
                          decoration: BoxDecoration(
                            color: c.accent,
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: Theme.of(context).scaffoldBackgroundColor,
                              width: 2,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            w.title ?? t.untitled,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 17,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                        if (last?.at case final at?) ...[
                          const SizedBox(width: 8),
                          Text(
                            rowTime(at, now, lang),
                            style: TextStyle(fontSize: 13, color: c.mutedFg),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 3),
                    // the folder names the window, as a messenger names the sender in a group
                    Row(
                      children: [
                        Expanded(
                          child: Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(
                                  text: last == null ? folder : '$folder: ',
                                  style: TextStyle(color: c.primary),
                                ),
                                if (last != null)
                                  TextSpan(
                                    text: last.role == 'user'
                                        ? '${t.youPrefix}${last.text}'
                                        : last.text,
                                  ),
                              ],
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 15, color: c.mutedFg),
                          ),
                        ),
                        if (w.pending)
                          _Badge('!', c.accent, c.background)
                        else if (unread > 0)
                          _Badge('$unread', c.primary, c.primaryFg),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.text, this.fill, this.fg);

  final String text;
  final Color fill, fg;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(left: 8),
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    constraints: const BoxConstraints(minWidth: 22),
    decoration: BoxDecoration(
      color: fill,
      borderRadius: BorderRadius.circular(11),
    ),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: fg),
    ),
  );
}
