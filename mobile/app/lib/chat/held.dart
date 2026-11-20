// Issue 499: a compaction ordered while the agent works waits for its next pause, and the messages sent meanwhile wait
// in the window behind it (and behind a pending restart). The chip under the feed says so and offers Cancel; the held
// messages show above it, dimmed, with what they wait for, as the desktop's feed shows them.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/strings.g.dart';
import '../theme.dart';
import 'chat_screen.dart';
import 'feed.dart';
import 'window_tab.dart';

class CompactPendingChip extends StatelessWidget {
  const CompactPendingChip(this.tab, {super.key});
  final WindowTab tab;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 8, 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              webString(WebKey.compactPending, lang),
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: c.accent,
              ),
            ),
          ),
          TextButton(
            onPressed: tab.state == TabState.open
                ? () => tab.send(const ClientMessageCompactCancel())
                : null,
            child: Text(webString(WebKey.compactCancel, lang)),
          ),
        ],
      ),
    );
  }
}

class HeldBubble extends StatelessWidget {
  const HeldBubble(this.held, {super.key, required this.restart});
  final HeldSend held;

  /// a restart is pending too: it goes first, so that is what the message waits for
  final bool restart;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    // the web's label is a suffix of the bubble's header (" · waits for …")
    final label = webString(
      restart ? WebKey.youHeldRestart : WebKey.youHeldCompact,
      lang,
    ).replaceFirst(RegExp(r'^\s*·\s*'), '');
    return Opacity(
      opacity: 0.6,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: [
          FeedItemView(
            UserItem(
              held.id,
              held.text,
              images: held.images ?? const [],
              voice: held.voice,
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 12, bottom: 4),
            child: Text(
              label,
              style: TextStyle(fontSize: 11, color: c.mutedFg),
            ),
          ),
        ],
      ),
    );
  }
}
