// The "Rename host" dialog: from a long-press on a host row and from its row in Settings. The name is kept on this
// phone only; Reset goes back to the name the computer sent.
import 'package:flutter/material.dart';

import '../l10n/app_localizations.dart';
import '../store/hosts.dart';

Future<void> renameHostDialog(
  BuildContext context,
  Hosts hosts,
  PairedHost host,
) async {
  final result = await showDialog<({String? name})>(
    context: context,
    builder: (_) => _RenameDialog(host),
  );
  if (result != null) await hosts.rename(host.id, result.name);
}

class _RenameDialog extends StatefulWidget {
  const _RenameDialog(this.host);

  final PairedHost host;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final _ctl = TextEditingController(text: widget.host.label);

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final computer = widget.host.computerName;
    return AlertDialog(
      title: Text(t.renameHost),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _ctl,
            autofocus: true,
            decoration: InputDecoration(labelText: t.hostNameLabel),
          ),
          const SizedBox(height: 12),
          Text(
            computer == null ? t.renameNoteOnly : t.renameNote(computer),
            style: const TextStyle(fontSize: 13),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, (name: null)),
          child: Text(t.reset),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(t.cancel),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, (name: _ctl.text)),
          child: Text(t.save),
        ),
      ],
    );
  }
}
