// The paired hosts (forget one here; the host side drops this phone with `nota-bene remote revoke`), the language,
// the colour theme and this phone's fingerprint, as the host lists it.
import 'package:flutter/material.dart';

import 'hosts/rename_host.dart';
import 'l10n/app_localizations.dart';
import 'notify/platform.dart';
import 'store/hosts.dart';
import 'store/notify_choice.dart';
import 'store/lang_choice.dart';
import 'store/sizes.dart';
import 'store/theme_choice.dart';
import 'store/voice_lang.dart';
import 'theme.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.identity,
    required this.hosts,
    required this.themes,
    this.langs,
    this.voiceLang,
    this.sizes,
    this.notify,
    required this.onPair,
  });

  final Identity identity;
  final Hosts hosts;
  final ThemeChoice themes;

  /// The app's language; no row without it.
  final LangChoice? langs;

  /// The language voice is transcribed in; no row without it.
  final VoiceLang? voiceLang;

  /// Text and interface size; no rows without it.
  final Sizes? sizes;

  /// The notifications switch; no row without it.
  final NotifySettings? notify;
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

  Future<void> _pickVoiceLang(BuildContext context, VoiceLang voice) =>
      showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (c) {
          final t = AppLocalizations.of(c);
          final primary = Theme.of(c).extension<NbColors>()!.primary;
          Widget row(String code, String name) => ListTile(
            title: Text(name),
            trailing: code == voice.code
                ? Icon(Icons.check, color: primary)
                : null,
            selected: code == voice.code,
            onTap: () {
              voice.choose(code);
              Navigator.pop(c);
            },
          );
          return SafeArea(
            child: ListView(
              shrinkWrap: true,
              children: [
                row(VoiceLang.auto, t.voiceLanguageAuto),
                for (final (code, name) in voiceLangs) row(code, name),
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
        listenable: Listenable.merge([
          hosts,
          themes,
          ?langs,
          ?voiceLang,
          ?sizes,
          ?notify?.choice,
        ]),
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
            if (notify case final n?) ...[
              const Divider(),
              SwitchListTile(
                key: const ValueKey('notify'),
                secondary: const Icon(Icons.notifications_outlined),
                title: Text(t.notifySetting),
                subtitle: Text(t.notifyHint),
                value: n.choice.on,
                onChanged: (on) async {
                  await n.choice.set(on);
                  await n.apply(on);
                },
              ),
              FutureBuilder<String>(
                future: n.platform.permission(),
                builder: (context, s) => s.data != 'denied'
                    ? const SizedBox.shrink()
                    : ListTile(
                        subtitle: Text(t.notifyDenied),
                        trailing: TextButton(
                          onPressed: n.platform.openSettings,
                          child: Text(t.notifyOpenSettings),
                        ),
                      ),
              ),
            ],
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
            if (voiceLang case final voice?) ...[
              const Divider(),
              ListTile(
                key: const ValueKey('voice-language'),
                leading: const Icon(Icons.record_voice_over_outlined),
                title: Text(t.voiceLanguage),
                subtitle: Text(
                  voice.isAuto
                      ? t.voiceLanguageAuto
                      : voiceLangName(voice.code),
                ),
                onTap: () => _pickVoiceLang(context, voice),
              ),
            ],
            if (sizes case final z?) ...[
              const Divider(),
              _SizeControls(sizes: z),
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

/// The text size slider, the interface size choice and a line showing both.
class _SizeControls extends StatelessWidget {
  const _SizeControls({required this.sizes});
  final Sizes sizes;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ListTile(
          title: Text(t.textSize),
          trailing: Text(
            percent(sizes.text),
            key: const ValueKey('text-size-value'),
          ),
        ),
        Slider(
          key: const ValueKey('text-size'),
          value: sizes.text,
          min: textSizes.first,
          max: textSizes.last,
          divisions: textSizes.length - 1,
          label: percent(sizes.text),
          // applied while dragging, written when the finger lifts
          onChanged: (v) => sizes.chooseText(
            textSizes.reduce((a, b) => (a - v).abs() < (b - v).abs() ? a : b),
            keep: false,
          ),
          onChangeEnd: (_) => sizes.keepText(),
        ),
        ListTile(title: Text(t.interfaceSize)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SegmentedButton<double>(
            key: const ValueKey('interface-size'),
            showSelectedIcon: false,
            segments: [
              for (final s in interfaceSizes)
                ButtonSegment(
                  value: s,
                  label: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(percent(s)),
                  ),
                ),
            ],
            selected: {sizes.interface},
            onSelectionChanged: (v) => sizes.chooseInterface(v.first),
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            t.sizePreview,
            key: const ValueKey('size-preview'),
            style: TextStyle(color: c.mutedFg),
          ),
        ),
      ],
    );
  }
}

/// What the notifications row needs: the stored choice, Android's permission, and how the app applies a change.
class NotifySettings {
  const NotifySettings({
    required this.choice,
    required this.platform,
    required this.apply,
  });

  final NotifyChoice choice;
  final BackgroundPlatform platform;
  final Future<void> Function(bool on) apply;
}
