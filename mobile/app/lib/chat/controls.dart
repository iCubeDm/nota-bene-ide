// The agent menu of the chat (Files; the rest lives in the window sheet) and the pieces the sheet reuses: the restart
// question and the model sheet (model: protocol 6+ with the models capability).
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import '../ui/nb_icon.dart';
import 'files.dart';
import 'window_tab.dart';

bool modelSwitchable(WindowTab tab) =>
    (tab.protocol ?? 0) >= 6 &&
    (tab.capabilities?.models ?? false) &&
    tab.models.isNotEmpty;

class AgentMenu extends StatelessWidget {
  const AgentMenu({super.key, required this.tab, this.onFiles});
  final WindowTab tab;

  /// Files: switches to the Files pane; without it the menu opens the session's files in a sheet.
  final VoidCallback? onFiles;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return PopupMenuButton<Object?>(
      tooltip: t.agentMenu,
      icon: const NbIcon(NbGlyph.more),
      // a round 40 x 40 button in the header's circle, not the 48 x 40 of the default icon button
      padding: EdgeInsets.zero,
      style: IconButton.styleFrom(
        fixedSize: const Size(40, 40),
        minimumSize: const Size(40, 40),
        padding: EdgeInsets.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      enabled: tab.state == TabState.open,
      onSelected: (v) {
        if (v != 'files') return;
        final go = onFiles;
        go != null ? go() : showFiles(context, tab);
      },
      itemBuilder: (_) => [
        PopupMenuItem<Object?>(value: 'files', child: Text(t.files)),
      ],
    );
  }
}

/// Asks to restart the agent; sends `restart` on a yes. True when it was sent.
Future<bool> askRestart(BuildContext context, WindowTab tab) async {
  final t = AppLocalizations.of(context);
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(t.restartAgentTitle),
      content: Text(t.restartAgentBody),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(c, false),
          child: Text(t.cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(c, true),
          child: Text(t.restart),
        ),
      ],
    ),
  );
  if (ok != true) return false;
  tab.send(const ClientMessageRestart());
  return true;
}

Future<void> showModelSheet(BuildContext context, WindowTab tab) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => ModelSheet(tab: tab),
    );

String effortLabel(AppLocalizations t, AgentEffort e) => switch (e) {
  AgentEffort.low => t.effortLow,
  AgentEffort.medium => t.effortMedium,
  AgentEffort.high => t.effortHigh,
  AgentEffort.xhigh => t.effortXhigh,
  AgentEffort.max => t.effortMax,
  AgentEffort.none => t.effortNone,
  AgentEffort.minimal => t.effortMinimal,
  AgentEffort.$unknown => '?',
};

class ModelSheet extends StatefulWidget {
  const ModelSheet({super.key, required this.tab});
  final WindowTab tab;

  @override
  State<ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<ModelSheet> {
  late String? _model = widget.tab.model;
  late AgentEffort? _effort = widget.tab.effort;

  ModelOption? get _option =>
      widget.tab.models.where((m) => m.value == _model).firstOrNull;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final efforts = _option?.efforts ?? const <AgentEffort>[];
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final m in widget.tab.models)
              ListTile(
                title: Text(m.name),
                subtitle: Text(
                  m.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: m.value == _model ? const Icon(Icons.check) : null,
                onTap: () => setState(() {
                  _model = m.value;
                  final e = m.efforts ?? const [];
                  if (!e.contains(_effort)) {
                    _effort = m.defaultEffort ?? (e.isEmpty ? null : e.first);
                  }
                }),
              ),
            if (efforts.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Wrap(
                  spacing: 8,
                  children: [
                    for (final e in efforts)
                      ChoiceChip(
                        label: Text(effortLabel(t, e)),
                        selected: e == _effort,
                        onSelected: (_) => setState(() => _effort = e),
                      ),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: FilledButton(
                onPressed: _model == null
                    ? null
                    : () {
                        widget.tab.send(
                          ClientMessageModel(
                            model: _model!,
                            effort: efforts.isEmpty ? null : _effort,
                            id: uuidV4(),
                          ),
                        );
                        Navigator.pop(context);
                      },
                child: Text(t.apply),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
