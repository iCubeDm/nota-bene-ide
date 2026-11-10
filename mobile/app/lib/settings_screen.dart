// The paired hosts (forget one here; the host side drops this phone with `nota-bene remote revoke`), the language,
// the colour theme and this phone's fingerprint, as the host lists it.
import 'package:flutter/material.dart';

import 'hosts/rename_host.dart';
import 'l10n/app_localizations.dart';
import 'store/hosts.dart';
import 'store/lang_choice.dart';
import 'store/theme_choice.dart';
import 'theme.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.identity,
    required this.hosts,
    required this.themes,
    this.langs,
    required this.onPair,
  });

  final Identity identity;
  final Hosts hosts;
  final ThemeChoice themes;

  /// The app's language; no row without it.
  final LangChoice? langs;
  final VoidCallback onPair;

  Future<void> _pickLang(BuildContext context, LangChoice langs) =>
      showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        // all seven rows, not cut at half the screen
        isScrollControlled: true,
        builder: (c) {
          final t = AppLocalizations.of(c);
          final primary = Theme.of(c).extension<NbColors>()!.primary;
          Widget row(String? code, String name) => ListTile(
            title: Text(name),
            trailing: code == langs.code
                ? Icon(Icons.check, color: primary)
                : null,
            selected: code == langs.code,
            onTap: () {
              langs.choose(code);
              Navigator.pop(c);
            },
          );
          return SafeArea(
            child: ListView(
              shrinkWrap: true,
              children: [
                row(null, t.languageSystem),
                for (final (code, name) in appLangs) row(code, name),
              ],
            ),
          );
        },
      );

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
        listenable: Listenable.merge([hosts, themes, ?langs]),
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
                onTap: () => renameHostDialog(context, hosts, h),
                onLongPress: () => renameHostDialog(context, hosts, h),
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
            if (langs case final langs?) ...[
              const Divider(),
              ListTile(
                key: const ValueKey('language'),
                leading: const Icon(Icons.translate),
                title: Text(t.language),
                subtitle: Text(
                  appLangs.where((l) => l.$1 == langs.code).firstOrNull?.$2 ??
                      t.languageSystem,
                ),
                onTap: () => _pickLang(context, langs),
              ),
            ],
            const Divider(),
            for (final dark in [true, false]) ...[
              ListTile(
                title: Text(
                  dark ? t.darkThemes : t.lightThemes,
                  style: TextStyle(color: c.mutedFg, fontSize: 13),
                ),
              ),
              for (final th in NbTheme.values.where((x) => x.dark == dark))
                ListTile(
                  leading: CircleAvatar(
                    radius: 10,
                    backgroundColor: th.colors.background,
                    child: CircleAvatar(
                      radius: 4,
                      backgroundColor: th.colors.primary,
                    ),
                  ),
                  title: Text(th.label),
                  trailing: th == themes.theme
                      ? Icon(Icons.check, color: c.primary)
                      : null,
                  selected: th == themes.theme,
                  onTap: () => themes.choose(th),
                ),
            ],
          ],
        ),
      ),
    );
  }
}
