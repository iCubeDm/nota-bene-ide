// The start screen: the session list grouped by host; at start, the chat opened last on this phone when its host is
// online and still lists that window.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nb_channel/nb_channel.dart';

import 'hosts/host_link.dart';
import 'hosts/icon_flow.dart';
import 'hosts/hosts_screen.dart';
import 'hosts/rename_host.dart';
import 'l10n/app_localizations.dart';
import 'notify/visible.dart';
import 'store/hosts.dart';
import 'store/seen.dart';

typedef ChatBuilder = Widget Function(String hostId, HostWindow w);

class Home extends StatefulWidget {
  const Home({
    super.key,
    required this.hosts,
    required this.seen,
    required this.links,
    required this.onPair,
    required this.chat,
    this.onSettings,
    this.opened,
    this.clock = DateTime.now,
  });

  final Hosts hosts;
  final Seen seen;
  final DateTime Function() clock;
  final Links links;
  final VoidCallback onPair;
  final VoidCallback? onSettings;
  final ChatBuilder chat;

  /// The chats of tapped notifications: each opens, over whatever chat is open.
  final Stream<ChatPlace>? opened;

  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  StreamSubscription<ChatPlace>? _tapped;
  bool _lastTried = false;

  /// A tapped notification's chat, opened as the last chat is at start (once its host has answered).
  String? _want;

  @override
  void initState() {
    super.initState();
    widget.links.addListener(_changed);
    widget.hosts.addListener(_changed);
    widget.seen.addListener(_changed);
    _tapped = widget.opened?.listen((p) {
      _want = '${p.hostId} ${p.port} ${p.root}';
      _lastTried = false;
      _openLast();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _openLast());
  }

  @override
  void dispose() {
    widget.links.removeListener(_changed);
    widget.hosts.removeListener(_changed);
    widget.seen.removeListener(_changed);
    unawaited(_tapped?.cancel());
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    _openLast();
  }

  /// Once, at start: the last chat, if its host answers and still lists it before anything else happens. Again for
  /// each tapped notification.
  void _openLast() {
    if (_lastTried || !mounted) return;
    final last = (_want ?? widget.hosts.lastChat)?.split(' ');
    if (last == null || last.length < 3) {
      _lastTried = true;
      return;
    }
    final link = widget.links.of(last[0]);
    if (link == null) {
      _lastTried = true;
      return;
    }
    if (link.state == LinkState.connecting) return; // wait for the first answer
    _lastTried = true;
    if (link.state != LinkState.online) return;
    final port = int.tryParse(last[1]);
    final root = last.sublist(2).join(' ');
    final w = link.windows
        .where((w) => w.port == port && w.root == root)
        .firstOrNull;
    if (w != null) _open(link, w);
  }

  void _open(HostLink link, HostWindow w) {
    _lastTried = true;
    _want = null;
    unawaited(widget.hosts.setLastChat('${link.host.id} ${w.port} ${w.root}'));
    Navigator.of(context)
      ..popUntil((r) => r.isFirst)
      ..push(
        MaterialPageRoute<void>(builder: (_) => widget.chat(link.host.id, w)),
      );
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final empty = widget.hosts.all.isEmpty;
    return Scaffold(
      appBar: AppBar(
        title: Text(t.appTitle),
        actions: [
          if (!empty)
            IconButton(
              tooltip: t.pairHost,
              icon: const Icon(Icons.qr_code_scanner),
              onPressed: widget.onPair,
            ),
          if (widget.onSettings != null)
            IconButton(
              tooltip: t.settings,
              icon: const Icon(Icons.settings_outlined),
              onPressed: widget.onSettings,
            ),
        ],
      ),
      body: empty
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(t.noHosts, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    FilledButton.icon(
                      onPressed: widget.onPair,
                      icon: const Icon(Icons.qr_code_scanner),
                      label: Text(t.pairHost),
                    ),
                  ],
                ),
              ),
            )
          : HostsList(
              links: widget.links.all,
              seen: widget.seen,
              clock: widget.clock,
              onOpen: _open,
              onForget: (l) => widget.hosts.forget(l.host.id),
              onRename: (l) => renameHostDialog(context, widget.hosts, l.host),
              onRefresh: widget.links.refresh,
              onSetIcon: (l, w) => setProjectIconFlow(context, l, w),
              onRemoveIcon: (l, w) => removeProjectIconFlow(context, l, w),
            ),
    );
  }
}
