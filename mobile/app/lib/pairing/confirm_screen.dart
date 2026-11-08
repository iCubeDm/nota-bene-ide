import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'pair_flow.dart';

/// After pairing: both fingerprints, to compare with what `nota-bene remote pair` printed on the host.
class ConfirmScreen extends StatelessWidget {
  const ConfirmScreen({super.key, required this.result, required this.onDone});

  final Paired result;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    Widget fp(String label, String value) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: c.mutedFg)),
          SelectableText(
            value,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 20),
          ),
        ],
      ),
    );
    return Scaffold(
      appBar: AppBar(title: Text(t.pairedTitle(result.host.label))),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(t.compareHint),
              const SizedBox(height: 12),
              fp(t.hostFingerprint, result.hostFingerprint),
              fp(t.phoneFingerprint, result.phoneFingerprint),
              const Spacer(),
              SizedBox(
                width: double.infinity,
                child: FilledButton(onPressed: onDone, child: Text(t.done)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
