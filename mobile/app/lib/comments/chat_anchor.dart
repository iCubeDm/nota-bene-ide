// The chat's anchors: which feed items can be commented on, the text of one as the desktop's anchor model reads it
// (web/src/anchors/text.ts over the item's element: the "you" header, the sent-comments details and the images are
// skipped), and what the batch calls the place (web/src/store/store.ts selectReplyLabel).
import 'dart:convert';

import 'package:markdown/markdown.dart' as md;
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/feed.dart';
import '../chat/markdown.dart';
import 'anchor.dart';
import 'strings.g.dart';

/// The anchor source of [it]: a user message or a final reply. A reply still streaming has none (the desktop's
/// `stream:*`), nor has a tool, a plan or a line of the feed.
AnchorSource? chatSource(FeedItem it) => switch (it) {
  UserItem(:final id, :final idle) when !idle => AnchorSourceMessage(id: id),
  AssistantItem(:final id, :final final_) when final_ => AnchorSourceMessage(
    id: id,
  ),
  _ => null,
};

/// The text of [it] the anchors count in: for a reply its Markdown; for a user message what the bubble shows, the
/// message without the comment batch it may carry. An item with no source is empty.
RenderedText chatText(FeedItem it) => switch (it) {
  AssistantItem(:final text) => renderedText(parseMarkdown(text)),
  UserItem(:final text) => renderedText(_parseUser(_general(text))),
  _ => renderedText(const []),
};

const _langs = ['en', 'ru', 'zh', 'es', 'pt', 'de'];

/// BATCH_HEAD (shared/src/lang.ts): every language's heading of a sent batch.
final _batchHead = RegExp(
  '(?:^|\\n\\n)(?:${_langs.map((l) => RegExp.escape(batchString('batchHead', l))).join('|')})\\n\\n',
);

/// A message with its batch of comments cut off, as UserMessage.tsx shows it (the batch is in its details).
String _general(String text) {
  final m = _batchHead.firstMatch(text);
  return m == null ? text : text.substring(0, m.start);
}

/// `@path` stays as typed when the message goes through Markdown (refs.ts escapeMentions): the mention's characters
/// that Markdown would eat get a backslash, outside code spans and fences.
String _escapeMentions(String text) {
  final mention = RegExp(r'(^|\s)@("[^"]+"|[^\s"]+)');
  final code = RegExp(r'(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)');
  return text.splitMapJoin(
    code,
    onMatch: (m) => m[0]!,
    onNonMatch: (seg) => seg.splitMapJoin(
      mention,
      onMatch: (m) =>
          '${m[1]}${'@${m[2]}'.replaceAllMapped(RegExp(r'[\\`*_~\[\]<>|&]'), (c) => '\\${c[0]}')}',
    ),
  );
}

/// What a person typed shows as text: `<Composer>` and a comment are not tags (the desktop's `noHtml`).
class _TypedHtml extends md.InlineHtmlSyntax {
  @override
  bool onMatch(md.InlineParser parser, Match m) {
    parser.addNode(md.Text(m[0]!));
    return true;
  }
}

class _TypedHtmlBlock extends md.HtmlBlockSyntax {
  @override
  md.Node parse(md.BlockParser parser) =>
      md.Element('p', [md.Text(super.parse(parser).textContent.trim())]);
}

List<md.Node> _parseUser(String text) => md.Document(
  blockSyntaxes: [nbBlockSyntaxes.first, _TypedHtmlBlock()],
  inlineSyntaxes: [nbInlineSyntaxes.first, _TypedHtml()],
  extensionSet: md.ExtensionSet.gitHubFlavored,
  encodeHtml: false,
).parseLines(const LineSplitter().convert(_escapeMentions(text)));

/// The batch's name for the place of a message, as `selectReplyLabel(…, plain)` gives it: "my message" for the
/// user's, "reply" for a final reply (no number: the quote is the locator), "chat" for one the feed no longer holds
/// (compacted away, or from before "show earlier").
String whereOfChat(String messageId, Feed feed, String lang) {
  for (final it in feed.items) {
    if (it is UserItem && it.id == messageId) return webString('srcMine', lang);
    if (it is AssistantItem && it.id == messageId) {
      return it.final_
          ? webString('replyPlain', lang)
          : batchString('srcChat', lang);
    }
  }
  return batchString('srcChat', lang);
}
