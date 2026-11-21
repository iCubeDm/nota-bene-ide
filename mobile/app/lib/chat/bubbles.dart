// The feed's pieces (issue 565: apart from the chat screen): an item's default look, the agent's and the user's
// bubbles, a voice message still going out, a tool call's line.
import 'package:flutter/material.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:nb_protocol/nb_protocol.dart' show StopReason;

import '../l10n/app_localizations.dart';
import '../comments/chat_anchor.dart';
import '../files/file_markdown.dart';
import '../theme.dart';
import '../voice/outbox.dart';
import '../voice/voice_bubble.dart';
import 'feed.dart';
import 'files.dart';
import 'media_card.dart';
import 'markdown.dart';
import 'sent_comments.dart';
import 'tool_group.dart';

/// The default look of one feed item.
class FeedItemView extends StatelessWidget {
  const FeedItemView(
    this.item, {
    super.key,
    this.listenerAt,
    this.marks = const [],
    this.onMark = _noMark,
    this.wrapBlock,
    this.wrapItem,
    this.tapItem,
    this.inertMarks = const {},
  });
  final FeedItem item;

  /// Marks whose text takes no tap (see [FileMarkdown.inertMarks]).
  final Set<String> inertMarks;

  /// A final reply's list items dressed as targets, and a tap on their bullets (see [FileMarkdown]).
  final Widget Function(int block, int item, Widget content, double bullet)?
  wrapItem;
  final void Function(int block, int item)? tapItem;

  /// A final reply's paragraphs dressed as targets of a comment (the chat's own list only).
  final Widget Function(int block, md.Node node, Widget child)? wrapBlock;

  /// Commented passages to paint (and number) in the text; a tap on one calls [onMark] with the comment's id.
  final List<Mark> marks;
  final void Function(String id) onMark;
  static void _noMark(String id) {}

  /// In selection mode: the Markdown is drawn block by block, each block's selection reported to its notifier.
  final SelectionListenerNotifier Function(int block)? listenerAt;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    Widget line(String text, {Color? color}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: TextStyle(color: color ?? c.mutedFg, fontSize: 13),
      ),
    );
    Widget userText(String text) => listenerAt == null && marks.isEmpty
        ? NbMarkdown(
            userMarkdownSource(text),
            blockSyntaxes: userBlockSyntaxes,
            inlineSyntaxes: userInlineSyntaxes,
            softLineBreak: true,
          )
        // the bubble shrinks to its text here as it does with NbMarkdown: a press found in one is in the other
        : IntrinsicWidth(
            child: FileMarkdown(
              text: text,
              listenerAt: listenerAt,
              marks: marks,
              onMark: onMark,
              parse: parseUserMessage,
              softLineBreak: true,
            ),
          );
    return switch (item) {
      UserItem(
        shownText: final text,
        id: final userId,
        text: final typed,
        :final idle,
        :final images,
        :final voice,
        :final voiceError,
        :final voiceLang,
        :final transcribing,
      ) =>
        idle
            ? line(t.idleCompact)
            : UserBubble(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (images.isNotEmpty && FileOpener.of(context) != null)
                      UserImages(tab: FileOpener.of(context)!, images: images),
                    if (voice != null)
                      VoiceBlock(
                        id: voice.id,
                        ms: voice.ms.toInt(),
                        wave: voice.wave,
                        load: voiceLoader(FileOpener.of(context), voice.id),
                        stage: voiceError != null
                            ? VoiceStage.error
                            : (transcribing
                                  ? VoiceStage.transcribing
                                  : VoiceStage.transcribed),
                        error: voiceError,
                        onRetry:
                            FileOpener.of(
                                  context,
                                )?.voiceOutbox.isRetrying(voice.id) ??
                                false
                            ? null
                            : () => retryVoice(context, voice),
                        transcript: () => userText(text),
                        lang: voiceLang,
                      )
                    else if (text.isNotEmpty || images.isEmpty)
                      userText(text),
                    if (FileOpener.of(context) case final tab?)
                      SentComments(tab: tab, id: userId, text: typed),
                  ],
                ),
              ),
      AssistantItem(:final text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child:
            listenerAt == null &&
                marks.isEmpty &&
                wrapBlock == null &&
                wrapItem == null
            ? NbMarkdown(text)
            : FileMarkdown(
                text: text,
                listenerAt: listenerAt,
                marks: marks,
                onMark: onMark,
                wrapBlock: wrapBlock,
                wrapItem: wrapItem,
                tapItem: tapItem,
                inertMarks: inertMarks,
              ),
      ),
      ToolItem() => ToolLine(item as ToolItem),
      // a turn that ended well leaves no line: the header says when it was done
      DoneItem(:final secs, :final status, :final error) =>
        status == StopReason.interrupted || status == StopReason.failed
            ? line(
                status == StopReason.interrupted
                    ? t.turnInterrupted(duration(t, secs))
                    : t.turnFailed(duration(t, secs), error ?? ''),
              )
            : const SizedBox.shrink(),
      MarkerItem(:final what, :final error) => line(switch (what) {
        MarkerKind.compacted => t.markerCompacted,
        MarkerKind.compactFailed => t.markerCompactFailed(error ?? ''),
        MarkerKind.cleared => t.markerCleared,
      }),
      PermissionItem(:final toolName, :final answer) => line(
        answer == null
            ? t.permissionAsked(toolName)
            : (answer ? t.allowed : t.denied),
        color: answer == null ? c.accent : null,
      ),
      ShellItem(:final cmd, :final output) => Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: c.codeBg,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: c.border),
        ),
        child: Text(
          '! $cmd\n$output',
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
        ),
      ),
      NoticeItem(:final text) => line(t.resumed(text)),
    };
  }
}

/// Whether [it] is a piece of the agent's turn: its texts, tool lines, plans and shell blocks. A user message and the
/// lines (done, markers, notices) are not; they end the turn.
bool inAgentTurn(FeedItem it) => switch (it) {
  AssistantItem(:final text) => text.isNotEmpty,
  ToolItem() || PermissionItem() || ShellItem() => true,
  _ => false,
};

/// One piece of the agent's turn in its bubble: 8 px from the left edge and 28 from the right, in the agent's colour.
/// The pieces of a turn sit one under the other without a gap, so [first] rounds the top and [last] the bottom (its
/// left corner stays square, the tail).
class AgentBubble extends StatelessWidget {
  const AgentBubble({
    super.key,
    required this.first,
    required this.last,
    required this.child,
  });
  final bool first, last;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Padding(
      padding: EdgeInsets.fromLTRB(8, first ? 6 : 0, 28, last ? 6 : 0),
      child: Container(
        key: const ValueKey('agent-bubble'),
        padding: EdgeInsets.fromLTRB(12, first ? 6 : 0, 12, last ? 6 : 0),
        decoration: BoxDecoration(
          color: c.agentBubble,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(first ? 14 : 0),
            topRight: Radius.circular(first ? 14 : 0),
            bottomLeft: Radius.circular(last ? 4 : 0),
            bottomRight: Radius.circular(last ? 14 : 0),
          ),
        ),
        child: child,
      ),
    );
  }
}

/// The user's bubble: right-aligned, tinted with the primary colour, its lower right corner square. It shrinks to its
/// content and takes at most the screen's width less 28 px at the left and 8 at the right.
class UserBubble extends StatelessWidget {
  const UserBubble({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 6, 8, 6),
      child: Align(
        alignment: Alignment.centerRight,
        child: Container(
          key: const ValueKey('bubble'),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: c.userBubble,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(14),
              topRight: Radius.circular(14),
              bottomLeft: Radius.circular(14),
              bottomRight: Radius.circular(4),
            ),
            border: Border.all(color: c.primary.withValues(alpha: .45)),
          ),
          // as the desktop shows it, and as chatText reads it: Markdown with breaks, HTML as text
          child: child,
        ),
      ),
    );
  }
}

/// A voice message the phone has recorded and the window has not shown yet: Sending…, or failed with Retry.
class PendingVoiceBubble extends StatelessWidget {
  const PendingVoiceBubble(this.entry, this.outbox, {super.key});
  final PendingVoice entry;
  final VoiceOutbox outbox;

  @override
  Widget build(BuildContext context) => UserBubble(
    child: VoiceBlock(
      id: entry.key,
      ms: entry.ms,
      wave: entry.wave,
      load: () => outbox.bytes(entry),
      stage: entry.stage == OutStage.failed
          ? VoiceStage.sendFailed
          : VoiceStage.sending,
      onRetry: () => outbox.retry(entry),
      onDelete: () => outbox.remove(entry),
    ),
  );
}

String duration(AppLocalizations t, num secs) => secs < 60
    ? t.durationSecs(secs.round())
    : t.durationMins(secs ~/ 60, (secs % 60).round());

/// A tool call as one line (name and its main argument); its result opens on tap.
class ToolLine extends StatefulWidget {
  const ToolLine(
    this.item, {
    super.key,
    this.inGroup = false,
    this.media = true,
  });
  final ToolItem item;

  /// false when a group's head shows the pictures of its actions
  final bool media;

  /// Inside an open group a failed line shows its output unasked.
  final bool inGroup;

  @override
  State<ToolLine> createState() => _ToolLineState();
}

class _ToolLineState extends State<ToolLine> {
  // without a tab (no FileOpener) the state is the line's own
  bool? _local;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final it = widget.item;
    final running = it.result == null;
    final ui = FileOpener.of(context)?.windowState.feedUi;
    final open =
        (ui == null ? _local : ui.toolOpen(it.id)) ??
        (widget.inGroup && it.isError);
    // a file of the project the phone opens (Markdown, an image, a video) opens over the chat
    final tab = FileOpener.of(context);
    final path = toolPath(it);
    final file = tab == null || path == null
        ? null
        : projectPath(tab.connection.root, path);
    return Padding(
      padding: EdgeInsets.only(left: it.sub ? 16 : 0, top: 2, bottom: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: running
                ? null
                : () => setState(() {
                    ui == null ? _local = !open : ui.setTool(it.id, !open);
                  }),
            child: Row(
              children: [
                Icon(
                  running
                      ? Icons.more_horiz
                      : (it.isError ? Icons.error_outline : Icons.check),
                  size: 14,
                  color: it.isError ? c.destructive : c.mutedFg,
                ),
                const SizedBox(width: 6),
                Text(it.name, style: TextStyle(color: c.accent, fontSize: 13)),
                if (!open && tab != null)
                  ListenableBuilder(
                    listenable: tab.comments,
                    builder: (context, _) {
                      final n = toolComments(tab.comments, it.id);
                      return n == 0
                          ? const SizedBox.shrink()
                          : Text(
                              ' · ${AppLocalizations.of(context).toolComments(n)}',
                              style: TextStyle(color: c.accent, fontSize: 13),
                            );
                    },
                  ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    it.arg,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12,
                      color: c.mutedFg,
                    ),
                  ),
                ),
                if (file != null)
                  IconButton(
                    tooltip: AppLocalizations.of(context).openFile,
                    visualDensity: VisualDensity.compact,
                    iconSize: 18,
                    icon: Icon(fileIcon(file), color: c.link),
                    onPressed: () => openFile(context, tab!, file),
                  ),
              ],
            ),
          ),
          if (tab != null && widget.media)
            for (final m in mediaOf(tab, it)) MediaCard(tab: tab, spec: m),
          if (open && it.result != null)
            Container(
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.all(8),
              constraints: const BoxConstraints(maxHeight: 320),
              decoration: BoxDecoration(
                color: c.codeBg,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: c.border),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  it.result!,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
