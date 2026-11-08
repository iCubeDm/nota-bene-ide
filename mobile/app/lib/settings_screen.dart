// The paired hosts (forget one here; the host side drops this phone with `nota-bene remote revoke`) and this phone's
// fingerprint, as the host lists it.
import 'package:flutter/material.dart';

import 'l10n/app_localizations.dart';
import 'store/hosts.dart';
import 'theme.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.identity,
    required this.hosts,
    required this.onPair,
  });

  final Identity identity;
  final Hosts hosts;
  final VoidCallback onPair;

  Future<void> _forget(BuildContext context, PairedHost h) async {
    final t = AppLocalizations.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(t.forgetTitle(h.label)),
        content: Text(t.forgetBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: Text(t.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: Text(t.forget),
          ),
        ],
      ),
    );
    if (ok == true) await hosts.forget(h.id);
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    return Scaffold(
      appBar: AppBar(title: Text(t.settings)),
      body: ListenableBuilder(
        listenable: hosts,
        builder: (context, _) => ListView(
          children: [
            ListTile(
              title: Text(
                t.pairedHosts,
                style: TextStyle(color: c.mutedFg, fontSize: 13),
              ),
            ),
            for (final h in hosts.all)
              ListTile(
                title: Text(h.label),
                subtitle: Text(h.relay.host),
                trailing: TextButton(
                  onPressed: () => _forget(context, h),
                  child: Text(t.forget),
                ),
              ),
            ListTile(
              leading: const Icon(Icons.qr_code_scanner),
              title: Text(t.pairHost),
              onTap: onPair,
            ),
            const Divider(),
            ListTile(
              title: Text(t.phoneFingerprint),
              subtitle: FutureBuilder<String>(
                future: identity.fingerprint,
                builder: (_, s) => SelectableText(
                  s.data ?? '',
                  style: const TextStyle(fontFamily: 'monospace'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
