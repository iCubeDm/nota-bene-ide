// What a send while the agent works asks, and the send of the pending comments alone (the comments pane's Send).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import 'window_tab.dart';

/// "Send now or after this turn": 'force', 'queue', or null when it was dismissed.
Future<String?> askSendNow(BuildContext context) {
  final t = AppLocalizations.of(context);
  return showDialog<String>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(t.sendNowTitle),
      content: Text(t.sendNowBody),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: Text(t.cancel)),
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
}

/// Sends the pending comments alone, as the composer's Send does with an empty field (the same batch, the same
/// question while the agent works). A refusal gives them back.
Future<void> sendPendingComments(BuildContext context, WindowTab tab) async {
  if (tab.comments.sendable.isEmpty) return;
  var force = false;
  if (tab.busy) {
    final choice = await askSendNow(context);
    if (choice == null || !context.mounted) return;
    force = choice == 'force';
  }
  // read now: the desktop may have sent or changed them while the question was up
  final comments = tab.comments.sendable;
  if (comments.isEmpty) return;
  final lang = Localizations.localeOf(context).languageCode;
  final batch = tab.composeComments('', comments, lang);
  final id = uuidV4();
  final ids = {for (final c in comments) c.id};
  final messenger = ScaffoldMessenger.maybeOf(context);
  final t = AppLocalizations.of(context);
  final sent = tab.send(
    ClientMessageSend(
      id: id,
      text: batch.text,
      force: force ? true : null,
      commentIds: [for (final c in comments) c.id],
      images: batch.images.isEmpty ? null : batch.images,
    ),
  );
  if (!sent) return;
  tab.comments.sending(ids);
  unawaited(
    tab.refusals
        .firstWhere((r) => r.id == id)
        .timeout(const Duration(seconds: 20))
        .then((r) {
          tab.comments.unsending(ids);
          messenger?.showSnackBar(
            SnackBar(
              content: Text(
                r.reason == ServerEventSendRefusedReason.switching
                    ? t.refusedSwitching
                    : t.refusedBusy,
              ),
            ),
          );
        })
        .catchError((Object _) {}),
  );
}
