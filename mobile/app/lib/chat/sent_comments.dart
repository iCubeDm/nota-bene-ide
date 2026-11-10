// Under a user's message: the comments that went with it, folded as "N comments" and opened by a tap, as the desktop's
// UserMessage.tsx shows them (web/src/feed/UserMessage.tsx). They are the window's comment set's `sent` ones with
// `sentIn` this message, so a replay shows them too; when the set has none of them but the message's text carries the
// batch, the batch's own text is shown folded instead.
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../comments/chat_anchor.dart' show batchRaw;
import '../comments/comments.dart' show labelLine, quoteOf;
import '../comments/strings.g.dart';
import '../theme.dart';
import '../voice/upload.dart' show voiceLoader;
import '../voice/voice_bubble.dart';
import 'markdown.dart';
import 'media_card.dart';
import 'window_tab.dart';

/// The sent comments of message [id] in [tab]'s set.
List<Comment> sentFor(WindowTab tab, String id) => [
  for (final c in tab.comments.all)
    if (c.status == CommentStatus.sent && c.sentIn == id) c,
];

class SentComments extends StatefulWidget {
  const SentComments({
    super.key,
    required this.tab,
    required this.id,
    required this.text,
  });
  final WindowTab tab;

  /// The message's id and its text (which may carry the batch).
  final String id, text;

  @override
  State<SentComments> createState() => _SentCommentsState();
}

class _SentCommentsState extends State<SentComments> {
  bool _open = false;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.tab.comments,
    builder: (context, _) {
      final sent = sentFor(widget.tab, widget.id);
      final raw = batchRaw(widget.text);
      if (sent.isEmpty && raw == null) return const SizedBox.shrink();
      final c = Theme.of(context).extension<NbColors>()!;
      final lang = Localizations.localeOf(context).languageCode;
      final head = sent.isEmpty
          ? webString('commentsLc', lang)
          : webCount('nComments', lang, sent.length);
      return Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            InkWell(
              key: const ValueKey('sent-comments'),
              onTap: () => setState(() => _open = !_open),
              borderRadius: BorderRadius.circular(6),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      _open ? Icons.expand_more : Icons.chevron_right,
                      size: 16,
                      color: c.mutedFg,
                    ),
                    Text(
                      head,
                      style: TextStyle(color: c.mutedFg, fontSize: 13),
                    ),
                  ],
                ),
              ),
            ),
            if (_open)
              if (sent.isNotEmpty)
                for (final x in sent)
                  _One(tab: widget.tab, comment: x, lang: lang)
              else
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: DefaultTextStyle.merge(
                    style: TextStyle(color: c.mutedFg, fontSize: 13),
                    child: NbMarkdown(raw!, softLineBreak: true),
                  ),
                ),
          ],
        ),
      );
    },
  );
}

class _One extends StatelessWidget {
  const _One({required this.tab, required this.comment, required this.lang});
  final WindowTab tab;
  final Comment comment;
  final String lang;

  /// What the comment is on: the quote, or a media file's name with its time and the number of shapes.
  String get _quote {
    final x = comment;
    return switch (x.anchor) {
      MediaAnchor(:final shapes) =>
        '${quoteOf(x)} · ${webCount('markShapes', lang, shapes.length)}',
      _ => quoteOf(x),
    };
  }

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final x = comment;
    final label = labelLine(x.label, lang);
    final quote = _quote;
    final images = [
      for (final (i, id) in (x.images ?? const <String>[]).indexed)
        ImageRef(id: id, mediaType: ImageType.image_png, label: '${i + 1}'),
    ];
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (quote.isNotEmpty)
            Container(
              decoration: BoxDecoration(
                border: Border(left: BorderSide(color: c.accent, width: 2)),
              ),
              padding: const EdgeInsets.only(left: 8),
              // text the user selected in rendered output: plain, never read as Markdown
              child: Text(
                quote,
                style: TextStyle(color: c.mutedFg, fontSize: 13),
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text('→ ', style: TextStyle(color: c.mutedFg, fontSize: 13)),
                if (label.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: Text(
                      label,
                      style: TextStyle(color: c.mutedFg, fontSize: 13),
                    ),
                  ),
                if (x.text.isNotEmpty)
                  Expanded(
                    child: Text(x.text, style: const TextStyle(fontSize: 13)),
                  ),
              ],
            ),
          ),
          for (final v in x.voice ?? const <VoiceClip>[])
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: VoiceBlock(
                id: v.id,
                ms: v.ms.toInt(),
                wave: v.wave,
                load: voiceLoader(tab, v.id),
                stage: VoiceStage.transcribed,
                transcript: () =>
                    Text(v.text, style: const TextStyle(fontSize: 13)),
              ),
            ),
          if (images.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: UserImages(tab: tab, images: images),
            ),
        ],
      ),
    );
  }
}
