// Asks from the agent. A plain permission (a tool wants to run) opens a bottom sheet over the chat with the whole
// command; a structured prompt (Codex and omp questions, choices with fields) is answered in the feed. Both send what
// the desktop's PermissionCard sends; an answer given anywhere (permission-done) settles them here too.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'feed.dart';
import 'window_tab.dart';

/// The desktop's labels for the agents' own choice ids and texts (web/src/feed/PermissionCard.tsx).
String choiceLabel(AppLocalizations t, InteractionChoicesItem c) {
  if (RegExp(r'^Approve .+ for this session$').hasMatch(c.label)) {
    return t.allowSession;
  }
  return switch (c.label) {
        'Allow for this turn' => t.allowTurn,
        'Allow for this session' => t.allowSession,
        'Deny' || 'Decline' || 'Reject' => t.deny,
        'Cancel' => t.cancel,
        'Accept' || 'Approve' || 'Allow once' => t.allow,
        'Send answers' => t.sendAnswers,
        'Always allow' => t.allowAlways,
        'Always reject' => t.denyAlways,
        _ => null,
      } ??
      switch (c.id) {
        'accept' => t.allow,
        'decline' => t.deny,
        'cancel' => t.cancel,
        'acceptForSession' => t.allowSession,
        _ => c.label,
      };
}

String promptTitle(AppLocalizations t, PermissionItem p) =>
    switch (p.prompt?.title) {
      'Additional Codex permissions' => t.codexPermissions,
      'MCP request' => t.mcpRequest,
      final String s => s,
      null => t.allowTool(p.toolName),
    };

String permissionBody(PermissionItem p) {
  final i = p.input;
  final v = i['command'] ?? i['file_path'];
  return v != null ? '$v' : const JsonEncoder.withIndent('  ').convert(i);
}

/// Opens the sheet for a plain ask that is still open, and closes it when the ask is answered anywhere.
class PermissionWatcher {
  PermissionWatcher(this.tab, this.context) {
    tab.addListener(_check);
  }

  final WindowTab tab;
  final BuildContext context;
  ModalBottomSheetRoute<void>? _route;
  String? _for;
  final _handled = <String>{};

  void dispose() => tab.removeListener(_check);

  void _check() {
    final f = _for;
    if (f != null && tab.state != TabState.open) {
      // the window went (offline, taken): an answer could not go; the ask opens again when it is back
      _handled.remove(f);
      _close();
      return;
    }
    if (f != null) {
      final it = tab.feed.items
          .whereType<PermissionItem>()
          .where((p) => p.id == f)
          .firstOrNull;
      if (it == null || it.answer != null) _close();
      return;
    }
    final next = tab.feed.items.whereType<PermissionItem>().where(
      (p) =>
          p.prompt == null &&
          p.answer == null &&
          !p.archived &&
          !_handled.contains(p.id),
    );
    if (next.isNotEmpty && tab.state == TabState.open) open(next.first);
  }

  void _close() {
    final r = _route;
    _route = null;
    _for = null;
    if (r != null && r.isActive) Navigator.of(context).removeRoute(r);
  }

  /// Opens the sheet for [p] (also from its line in the feed after the sheet was swiped away).
  void open(PermissionItem p) {
    if (_for != null || !context.mounted) return;
    _for = p.id;
    _handled.add(p.id);
    final route = _route = ModalBottomSheetRoute<void>(
      isScrollControlled: true,
      builder: (c) => _Sheet(
        item: p,
        onAnswer: (allow) {
          if (!tab.send(ClientMessagePermission(id: p.id, allow: allow))) {
            _handled.remove(p.id);
          }
          _close();
        },
      ),
    );
    Navigator.of(context).push(route).then((_) {
      if (identical(_route, route)) {
        _route = null;
        _for = null;
      }
    });
  }
}

class _Sheet extends StatelessWidget {
  const _Sheet({required this.item, required this.onAnswer});
  final PermissionItem item;
  final void Function(bool allow) onAnswer;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              promptTitle(t, item),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 10),
            ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.sizeOf(context).height * 0.5,
              ),
              child: Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: c.codeBg,
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: c.border),
                ),
                child: SingleChildScrollView(
                  child: SelectableText(
                    permissionBody(item),
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 13,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => onAnswer(false),
                    child: Text(t.deny),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: () => onAnswer(true),
                    child: Text(t.allow),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// A structured prompt, answered in the feed.
class PromptCard extends StatefulWidget {
  const PromptCard({super.key, required this.item, required this.tab});
  final PermissionItem item;
  final WindowTab tab;

  @override
  State<PromptCard> createState() => _PromptCardState();
}

class _PromptCardState extends State<PromptCard> {
  final _values = <String, TextEditingController>{};

  @override
  void dispose() {
    for (final c in _values.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _field(String id) => _values.putIfAbsent(
    id,
    () => TextEditingController()..addListener(() => setState(() {})),
  );

  List<String> _picked(String id) => _field(
    id,
  ).text.split(',').map((v) => v.trim()).where((v) => v.isNotEmpty).toList();

  void _pick(InteractionFieldsItem f, String o) {
    final picked = _picked(f.id);
    final next = f.multi == true
        ? (picked.contains(o)
              ? picked.where((v) => v != o).toList()
              : [...picked, o])
        : (picked.length == 1 && picked.first == o ? <String>[] : [o]);
    _field(f.id).text = next.join(', ');
  }

  Widget _fieldView(InteractionFieldsItem f, NbColors c) {
    final options = f.options ?? const <String>[];
    final picked = _picked(f.id);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (f.header != null && f.header!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                f.header!,
                style: TextStyle(fontSize: 12, color: c.mutedFg),
              ),
            ),
          TextField(
            controller: _field(f.id),
            obscureText: f.secret == true,
            autocorrect: false,
            decoration: InputDecoration(
              labelText: f.label,
              border: const OutlineInputBorder(),
              isDense: true,
            ),
          ),
          for (var i = 0; i < options.length; i++)
            Material(
              type: MaterialType.transparency,
              child: ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  picked.contains(options[i])
                      ? (f.multi == true
                            ? Icons.check_box
                            : Icons.radio_button_checked)
                      : (f.multi == true
                            ? Icons.check_box_outline_blank
                            : Icons.radio_button_unchecked),
                  color: picked.contains(options[i]) ? c.accent : c.mutedFg,
                ),
                title: Text(options[i]),
                subtitle:
                    (f.notes != null &&
                        i < f.notes!.length &&
                        f.notes![i].isNotEmpty)
                    ? Text(f.notes![i])
                    : null,
                onTap: () => _pick(f, options[i]),
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final p = widget.item, prompt = p.prompt!;
    final settled = p.answer != null || p.archived;
    final fields = prompt.fields ?? const [];
    final missing = fields.any(
      (f) => f.required == true && _field(f.id).text.trim().isEmpty,
    );
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.card,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: settled ? c.borderSoft : c.accent),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            promptTitle(t, p),
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          if (p.input.isNotEmpty) ...[
            const SizedBox(height: 6),
            SelectableText(
              permissionBody(p),
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            ),
          ],
          if (settled)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                p.archived && p.answer == null
                    ? t.askArchived
                    : (p.answer == true
                          ? (fields.isEmpty ? t.allowed : t.answerSent)
                          : t.denied),
                style: TextStyle(color: c.mutedFg),
              ),
            )
          else ...[
            for (final f in fields) _fieldView(f, c),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final ch in prompt.choices)
                  FilledButton(
                    onPressed:
                        missing &&
                            !const ['cancel', 'decline', 'deny'].contains(ch.id)
                        ? null
                        : () => widget.tab.send(
                            ClientMessagePermission(
                              id: p.id,
                              allow: true,
                              response: InteractionAnswer(
                                choice: ch.id,
                                values_: prompt.fields == null
                                    ? null
                                    : {
                                        for (final f in fields)
                                          f.id: _field(f.id).text,
                                      },
                              ),
                            ),
                          ),
                    child: Text(choiceLabel(t, ch)),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
