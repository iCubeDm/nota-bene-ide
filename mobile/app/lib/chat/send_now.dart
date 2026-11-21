// What a send while the agent works asks, and the send of the pending comments alone (the comments pane's Send).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import 'window_tab.dart';

/// "Send now or after this turn", as [AskSendNow] answers it.
Future<bool?> askSendNow(BuildContext context) {
  final t = AppLocalizations.of(context);
  return showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(t.sendNowTitle),
      content: Text(t.sendNowBody),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: Text(t.cancel)),
        TextButton(
          onPressed: () => Navigator.pop(c, false),
          child: Text(t.sendAfter),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(c, true),
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
  final lang = Localizations.localeOf(context).languageCode;
  final messenger = ScaffoldMessenger.maybeOf(context);
  final t = AppLocalizations.of(context);
  final sent = await tab.send(
    '',
    lang: lang,
    ask: () async {
      final now = await askSendNow(context);
      return context.mounted ? now : null;
    },
  );
  if (sent == null) return;
  final (:id, comments: ids) = sent;
  unawaited(
    tab.windowState.refusals
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
