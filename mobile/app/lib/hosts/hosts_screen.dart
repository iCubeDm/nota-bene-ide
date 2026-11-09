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
    this.clock = DateTime.now,
  });

  final Iterable<HostLink> links;
  final Seen seen;
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
    return ListView(children: rows);
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
    final mono = TextStyle(
      fontFamily: 'monospace',
      fontSize: 11,
      color: c.mutedFg,
    );
    return Opacity(
      key: ValueKey('dim-${w.port}'),
      opacity: online ? 1 : 0.5,
      child: InkWell(
        onTap: online ? onOpen : null,
        onLongPress: () => _menu(context),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: Row(
            children: [
              SizedBox.square(
                dimension: 44,
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
                          fontSize: 17,
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
                          width: 12,
                          height: 12,
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
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            w.title ?? t.untitled,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        if (last?.at case final at?) ...[
                          const SizedBox(width: 8),
                          Text(
                            rowTime(at, now, lang),
                            style: TextStyle(fontSize: 12, color: c.mutedFg),
                          ),
                        ],
                      ],
                    ),
                    if (last != null || w.pending || unread > 0)
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              last == null
                                  ? ''
                                  : last.role == 'user'
                                  ? '${t.youPrefix}${last.text}'
                                  : last.text,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 13, color: c.mutedFg),
                            ),
                          ),
                          if (w.pending)
                            _Badge('!', c.accent, c.background)
                          else if (unread > 0)
                            _Badge('$unread', c.primary, c.primaryFg),
                        ],
                      ),
                    Text(
                      [folderOf(w.root), ?w.model].join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: mono,
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
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    constraints: const BoxConstraints(minWidth: 20),
    decoration: BoxDecoration(
      color: fill,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: fg),
    ),
  );
}
