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
  UserItem(:final id, :final idle, :final voice, :final shownText)
      when !idle && (voice == null || shownText.isNotEmpty) =>
    AnchorSourceMessage(id: id),
  AssistantItem(:final id, :final final_) when final_ => AnchorSourceMessage(
    id: id,
  ),
  _ => null,
};

/// The text of [it] the anchors count in: for a reply its Markdown; for a user message what the bubble shows, the
/// message without the comment batch it may carry. An item with no source is empty.
RenderedText chatText(FeedItem it) => switch (it) {
  AssistantItem(:final text) => renderedText(parseMarkdown(text)),
  UserItem(:final shownText) => renderedText(_parseUser(_general(shownText))),
  _ => renderedText(const []),
};

/// The part of [chatText] the [ordinal]th code block of [it] covers (0-based, the order the blocks are in), or null.
({int start, int end})? chatCodeRange(FeedItem it, int ordinal) {
  final nodes = switch (it) {
    AssistantItem(:final text) => parseMarkdown(text),
    UserItem(:final shownText) => _parseUser(_general(shownText)),
    _ => const <md.Node>[],
  };
  md.Element? pre;
  void find(md.Node n) {
    if (pre != null || n is! md.Element) return;
    if (n.tag == 'pre' && n.attributes[codeOrdinalAttr] == '$ordinal') {
      pre = n;
      return;
    }
    n.children?.forEach(find);
  }

  nodes.forEach(find);
  if (pre == null) return null;
  final inside = <md.Node>{};
  void collect(md.Node n) {
    if (n is md.Text) inside.add(n);
    if (n is md.Element) n.children?.forEach(collect);
  }

  collect(pre!);
  final r = renderedText(nodes);
  int? start, end;
  for (final run in r.runs) {
    if (!inside.contains(run.node)) continue;
    start = start == null ? run.start : (run.start < start ? run.start : start);
    end = end == null
        ? run.map.last
        : (run.map.last > end ? run.map.last : end);
  }
  return start == null || end == null ? null : (start: start, end: end);
}

/// The raw text of [it] a person copies or quotes: a reply's Markdown source, a user message without its batch.
String chatRaw(FeedItem it) => switch (it) {
  AssistantItem(:final text) => text,
  UserItem(:final shownText) => _general(shownText),
  _ => '',
};

/// What the user bubble hands the Markdown widget, so that it shows what [chatText] reads: the message without its
/// batch, mentions kept as typed, the HTML as text, the line breaks kept.
String userMarkdownSource(String text) => _escapeMentions(_general(text));
final userBlockSyntaxes = <md.BlockSyntax>[
  nbBlockSyntaxes.first,
  _TypedHtmlBlock(),
  ...nbCodeSyntaxes,
];
final userInlineSyntaxes = <md.InlineSyntax>[
  nbInlineSyntaxes.first,
  _TypedHtml(),
];

/// The nodes of a user message as its bubble shows them (what [chatText] reads).
List<md.Node> parseUserMessage(String text) => _parseUser(_general(text));

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
  blockSyntaxes: userBlockSyntaxes,
  inlineSyntaxes: userInlineSyntaxes,
  extensionSet: md.ExtensionSet.gitHubFlavored,
  encodeHtml: false,
).parseLines(const LineSplitter().convert(_escapeMentions(text)));

const _toolSrc = 'tool:';
const _argCut = 60;

/// The batch's name for the place of a source, as `whereOf` / `selectReplyLabel(…, plain)` give it: "my message" for
/// the user's, "reply" for a final reply (no number: the quote is the locator), "Bash command (npm test)" for an
/// action (the argument cut to 60), the plan mode's name for `plan:<id>` of a permission in the feed, and the
/// subagent forms for a source in [agent]'s conversation; "chat" for one the feed no longer holds (compacted away, or
/// from before "show earlier"). The phone holds no subagent's own feed: an action is looked for in the chat's, and
/// a subagent is named by its Agent call's description there, as the desktop does after a reload with its tab closed.
String whereOfChat(String messageId, Feed feed, String lang, {String? agent}) {
  String fill(String key, List<Object> args) => batchTemplate(key, lang, args);
  String? tool() {
    if (!messageId.startsWith(_toolSrc)) return null;
    final id = messageId.substring(_toolSrc.length);
    for (final it in feed.items) {
      if (it is ToolItem && it.id == id) {
        final arg = it.arg.length > _argCut
            ? '${it.arg.substring(0, _argCut)}…'
            : it.arg;
        return arg.isEmpty
            ? fill('srcToolBare', [it.name])
            : fill('srcTool', [it.name, arg]);
      }
    }
    return null;
  }

  if (agent != null && agent.isNotEmpty) {
    var name = '';
    for (final it in feed.items) {
      if (it is ToolItem && it.id == agent) {
        final d = it.input['description'];
        if (d is String && d.isNotEmpty) name = d;
      }
    }
    final what = tool();
    if (what != null) {
      return name.isEmpty
          ? fill('srcAgentToolBare', [what])
          : fill('srcAgentTool', [what, name]);
    }
    return name.isEmpty
        ? batchString('srcAgentReplyBare', lang)
        : fill('srcAgentReply', [name]);
  }
  final what = tool();
  if (what != null) return what;
  if (messageId.startsWith('plan:')) {
    final ok = feed.items.any(
      (it) => it is PermissionItem && 'plan:${it.id}' == messageId,
    );
    return ok ? webString('mode_plan', lang) : batchString('srcChat', lang);
  }
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
