import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:nb_channel/nb_channel.dart';

import '../l10n/app_localizations.dart';
import '../chat/chat_header.dart' show providerLetter;
import '../store/project_icons.dart';
import '../store/seen.dart';
import '../theme.dart';
import '../ui/time.dart';
import 'host_link.dart';
import 'project_icon.dart';

String folderOf(String root) {
  final parts = root.split(RegExp(r'[\\/]')).where((p) => p.isNotEmpty);
  return parts.isEmpty ? root : parts.last;
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
    required this.icons,
    required this.onOpen,
    required this.onForget,
    this.onRename,
    this.onRefresh,
    this.onSetIcon,
    this.onRemoveIcon,
    this.clock = DateTime.now,
  });

  final Iterable<HostLink> links;
  final Seen seen;

  /// The project pictures fetched so far.
  final ProjectIcons icons;
  final void Function(HostLink link, HostWindow w) onOpen;
  final void Function(HostLink link) onForget;

  /// Long-press on a host row.
  final void Function(HostLink link)? onRename;

  /// Pull to refresh; the indicator stays until this completes.
  final Future<void> Function()? onRefresh;

  /// Set icon / Remove icon in a row's menu; the first is offered for a host that knows project pictures, the second
  /// for a window that has one.
  final void Function(HostLink link, HostWindow w)? onSetIcon, onRemoveIcon;
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
        for (final e in groupWindows(l.windows)) {
          final w = e.window;
          rows.add(
            _SessionRow(
              icons: icons,
              link: l,
              window: w,
              nested: e.nested,
              helpers: e.helpers,
              onOpenHelper: (h) => onOpen(l, h),
              online: l.state == LinkState.online,
              unread: seen.unread(l.host.id, w),
              now: clock(),
              onOpen: () => onOpen(l, w),
              onSetIcon: onSetIcon == null || !l.iconsSupported
                  ? null
                  : () => onSetIcon!(l, w),
              onRemoveIcon: onRemoveIcon == null || w.icon == null
                  ? null
                  : () => onRemoveIcon!(l, w),
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

/// A host's row as the list shows it (epic 383 phase 3): `nested` for a folder's later agents, kept under its first;
/// `helpers` the agents this one started, which have no row of their own.
typedef WindowEntry = ({
  HostWindow window,
  bool nested,
  List<HostWindow> helpers,
});

/// A folder's agents together, in the order the first of each came; a helper under its lead (the row with its agent
/// id, else the window on its port, whose own id the host stream does not name).
List<WindowEntry> groupWindows(List<HostWindow> ws) {
  HostWindow? leadOf(HostWindow h) {
    final id = h.lead;
    if (id == null) return null;
    return ws.where((x) => x.agent == id).firstOrNull ??
        ws.where((x) => x.agent == null && x.port == h.port).firstOrNull;
  }

  final helperOf = <HostWindow, HostWindow>{for (final h in ws) h: ?leadOf(h)};
  final top = ws.where((w) => !helperOf.containsKey(w)).toList();
  final placed = <HostWindow>{};
  final out = <WindowEntry>[];
  for (final w in top) {
    if (placed.contains(w)) continue;
    final same = top
        .where((x) => x.root == w.root && !placed.contains(x))
        .toList();
    for (final (i, x) in same.indexed) {
      placed.add(x);
      out.add((
        window: x,
        nested: i > 0,
        helpers: [
          for (final e in helperOf.entries)
            if (e.value == x) e.key,
        ],
      ));
    }
  }
  return out;
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
    required this.link,
    required this.icons,
    required this.window,
    required this.online,
    required this.unread,
    required this.now,
    required this.onOpen,
    required this.onMarkRead,
    required this.onOpenHelper,
    this.nested = false,
    this.helpers = const [],
    this.onSetIcon,
    this.onRemoveIcon,
  });

  final HostLink link;
  final ProjectIcons icons;
  final HostWindow window;
  final bool online;

  /// a folder's later agent, under its first
  final bool nested;

  /// the agents this one started (epic 383 2g): a chip that opens them
  final List<HostWindow> helpers;
  final void Function(HostWindow helper) onOpenHelper;
  final int unread;
  final DateTime now;
  final VoidCallback onOpen, onMarkRead;
  final VoidCallback? onSetIcon, onRemoveIcon;

  /// the agents this one started: one opens
  Future<void> _helpers(BuildContext context) => showModalBottomSheet<void>(
    context: context,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final h in helpers)
            ListTile(
              title: Text(h.title ?? AppLocalizations.of(context).untitled),
              subtitle: Text(providerName(h.provider)),
              onTap: () {
                Navigator.pop(sheet);
                onOpenHelper(h);
              },
            ),
        ],
      ),
    ),
  );

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
            if (online && onSetIcon != null)
              ListTile(
                title: Text(t.setIcon),
                onTap: () {
                  Navigator.pop(sheet);
                  onSetIcon!();
                },
              ),
            if (online && onRemoveIcon != null)
              ListTile(
                title: Text(t.removeIcon),
                onTap: () {
                  Navigator.pop(sheet);
                  onRemoveIcon!();
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
          padding: EdgeInsets.fromLTRB(nested ? 40 : 16, 10, 16, 10),
          child: Row(
            children: [
              SizedBox.square(
                dimension: 54,
                child: Stack(
                  children: [
                    ProjectIconAvatar(
                      icons: icons,
                      link: link,
                      port: w.port,
                      agent: w.agent,
                      icon: w.icon,
                      size: 54,
                      semanticLabel: providerName(w.provider),
                      badge: ProviderBadge(
                        letter: providerLetter(w.provider),
                        size: 20,
                        fill: c.muted,
                        fg: c.foreground,
                        ring: Theme.of(context).scaffoldBackgroundColor,
                      ),
                      fallback: Container(
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
                    ),
                    if (w.busy == true)
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
                        if (last?.time case final at?) ...[
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
                                    text: last.role == LastMessageRole.user
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
                        if (w.pending == true)
                          _Badge('!', c.accent, c.background)
                        else if (unread > 0)
                          _Badge('$unread', c.primary, c.primaryFg),
                      ],
                    ),
                    if (helpers.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: InkWell(
                          key: ValueKey('helpers-${w.agent ?? w.port}'),
                          borderRadius: BorderRadius.circular(8),
                          onTap: online ? () => _helpers(context) : null,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 2),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  t.helpers(helpers.length),
                                  style: TextStyle(
                                    fontSize: 13,
                                    color: c.mutedFg,
                                  ),
                                ),
                                for (final h in helpers)
                                  Container(
                                    margin: const EdgeInsets.only(left: 4),
                                    width: 7,
                                    height: 7,
                                    decoration: BoxDecoration(
                                      color: h.pending == true
                                          ? c.accent
                                          : h.busy == true
                                          ? c.primary
                                          : c.success,
                                      shape: BoxShape.circle,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
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
