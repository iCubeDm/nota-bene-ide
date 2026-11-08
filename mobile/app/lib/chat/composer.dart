// The message field. Sending while the agent works asks first and then interrupts (force), as the desktop does; a send
// the window refuses gives its text back. Disabled, not queued, while the tab does not own a live window.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import 'window_tab.dart';

class Composer extends StatefulWidget {
  const Composer({super.key, required this.tab});
  final WindowTab tab;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _text = TextEditingController();
  StreamSubscription<ServerEventSendRefused>? _refused;
  ({String id, String text})? _last;

  @override
  void initState() {
    super.initState();
    _refused = widget.tab.refusals.listen(_onRefused);
    _text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _refused?.cancel();
    _text.dispose();
    super.dispose();
  }

  void _onRefused(ServerEventSendRefused r) {
    final last = _last;
    if (!mounted || last == null || last.id != r.id) return;
    if (_text.text.isEmpty) _text.text = last.text;
    final t = AppLocalizations.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          r.reason == ServerEventSendRefusedReason.switching
              ? t.refusedSwitching
              : t.refusedBusy,
        ),
      ),
    );
  }

  Future<void> _send() async {
    final text = _text.text.trim();
    if (text.isEmpty) return;
    var force = false;
    if (widget.tab.busy) {
      // as on the desktop: a message while the agent works waits for its turn, unless it is sent now and interrupts
      final t = AppLocalizations.of(context);
      final choice = await showDialog<String>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(t.sendNowTitle),
          content: Text(t.sendNowBody),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c),
              child: Text(t.cancel),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c, 'queue'),
              child: Text(t.sendAfter),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(c, 'force'),
              child: Text(t.sendNow),
            ),
          ],
        ),
      );
      if (choice == null || !mounted) return;
      force = choice == 'force';
    }
    final id = uuidV4();
    // the text stays when the window is not there to take it (the tab went offline or was taken meanwhile)
    final sent = widget.tab.send(
      ClientMessageSend(id: id, text: text, force: force ? true : null),
    );
    if (!sent) return;
    _last = (id: id, text: text);
    _text.clear();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.tab,
    builder: (context, _) {
      final t = AppLocalizations.of(context);
      final open = widget.tab.state == TabState.open;
      return Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: _text,
                enabled: open,
                minLines: 1,
                maxLines: 6,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(
                  hintText: open ? t.messageHint : t.cannotSend,
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ),
            if (open && widget.tab.busy)
              IconButton(
                tooltip: t.stop,
                icon: const Icon(Icons.stop_circle_outlined),
                onPressed: () =>
                    widget.tab.send(const ClientMessageInterrupt()),
              ),
            IconButton(
              tooltip: t.send,
              icon: const Icon(Icons.send),
              onPressed: open && _text.text.trim().isNotEmpty ? _send : null,
            ),
          ],
        ),
      );
    },
  );
}
