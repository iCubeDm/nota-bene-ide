// The start screen: the session list grouped by host; at start, the chat opened last on this phone when its host is
// online and still lists that window.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nb_channel/nb_channel.dart';

import 'hosts/host_link.dart';
import 'hosts/hosts_screen.dart';
import 'l10n/app_localizations.dart';
import 'store/hosts.dart';

typedef ChatBuilder = Widget Function(String hostId, HostWindow w);

class Home extends StatefulWidget {
  const Home({
    super.key,
    required this.hosts,
    required this.links,
    required this.onPair,
    required this.chat,
    this.onSettings,
  });

  final Hosts hosts;
  final Links links;
  final VoidCallback onPair;
  final VoidCallback? onSettings;
  final ChatBuilder chat;

  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  late final AppLifecycleListener _life;
  Timer? _pause;
  bool _lastTried = false;

  @override
  void initState() {
    super.initState();
    widget.links.addListener(_changed);
    widget.hosts.addListener(_changed);
    _life = AppLifecycleListener(
      onHide: () =>
          _pause ??= Timer(const Duration(minutes: 10), widget.links.pause),
      onShow: () {
        _pause?.cancel();
        _pause = null;
        widget.links.resume();
      },
    );
    WidgetsBinding.instance.addPostFrameCallback((_) => _openLast());
  }

  @override
  void dispose() {
    widget.links.removeListener(_changed);
    widget.hosts.removeListener(_changed);
    _life.dispose();
    _pause?.cancel();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    _openLast();
  }

  /// Once, at start: the last chat, if its host answers and still lists it before anything else happens.
  void _openLast() {
    if (_lastTried || !mounted) return;
    final last = widget.hosts.lastChat?.split(' ');
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
    unawaited(widget.hosts.setLastChat('${link.host.id} ${w.port} ${w.root}'));
    Navigator.of(context).push(
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
              onOpen: _open,
              onForget: (l) => widget.hosts.forget(l.host.id),
            ),
    );
  }
}
