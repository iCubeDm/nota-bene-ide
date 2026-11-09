// The agent menu of the chat: compact, model and effort, restart the agent. Each sends what the desktop sends, under
// the same conditions (compact: not while busy, when the agent can; model: protocol 6+ with the models capability).
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/strings.g.dart';
import '../l10n/app_localizations.dart';
import '../ui/nb_icon.dart';
import '../usage/usage_screen.dart';
import 'files.dart';
import 'window_tab.dart';

bool modelSwitchable(WindowTab tab) =>
    (tab.protocol ?? 0) >= 6 &&
    (tab.capabilities?.models ?? false) &&
    tab.models.isNotEmpty;

class AgentMenu extends StatelessWidget {
  const AgentMenu({super.key, required this.tab});
  final WindowTab tab;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final open = tab.state == TabState.open;
    final lang = Localizations.localeOf(context).languageCode;
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
      enabled: open,
      onSelected: (v) => switch (v) {
        'compact' => tab.send(
          const ClientMessageCommand(name: ClientMessageCommandName.compact),
        ),
        'model' => _model(context),
        'restart' => _restart(context),
        'files' => showFiles(context, tab),
        'usage' => Navigator.of(
          context,
        ).push(MaterialPageRoute<void>(builder: (_) => UsageScreen(tab: tab))),
        _ => null,
      },
      itemBuilder: (_) => [
        PopupMenuItem<Object?>(
          value: 'compact',
          enabled: open && !tab.busy && (tab.capabilities?.compact ?? true),
          child: Text(t.compact),
        ),
        if (modelSwitchable(tab))
          PopupMenuItem<Object?>(value: 'model', child: Text(t.modelAndEffort)),
        PopupMenuItem<Object?>(value: 'restart', child: Text(t.restartAgent)),
        const PopupMenuDivider(),
        PopupMenuItem<Object?>(value: 'files', child: Text(t.files)),
        PopupMenuItem<Object?>(
          value: 'usage',
          enabled: open && (tab.capabilities?.usage ?? true),
          child: Text(usageString('usage', lang)),
        ),
      ],
    );
  }

  Future<void> _restart(BuildContext context) async {
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
    if (ok == true) tab.send(const ClientMessageRestart());
  }

  Future<void> _model(BuildContext context) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => ModelSheet(tab: tab),
  );
}

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

  String _effortLabel(AppLocalizations t, AgentEffort e) => switch (e) {
    AgentEffort.low => t.effortLow,
    AgentEffort.medium => t.effortMedium,
    AgentEffort.high => t.effortHigh,
    AgentEffort.xhigh => t.effortXhigh,
    AgentEffort.max => t.effortMax,
    AgentEffort.none => t.effortNone,
    AgentEffort.minimal => t.effortMinimal,
    AgentEffort.$unknown => '?',
  };

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
                        label: Text(_effortLabel(t, e)),
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
