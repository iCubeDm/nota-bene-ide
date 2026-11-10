// A window's chat as a route: it owns the tab (made on push, closed on pop) and puts the composer, the agent menu,
// the asks and the one-tab overlay around the feed.
import 'dart:async';

import 'package:flutter/material.dart';

import '../hosts/host_link.dart';
import '../l10n/app_localizations.dart';
import '../store/seen.dart';
import '../theme.dart';
import '../comments/comment_strip.dart';
import '../comments/comments_pane.dart';
import '../files/files_pane.dart';
import 'chat_header.dart';
import 'chat_screen.dart';
import 'panes.dart';
import 'composer.dart';
import 'feed.dart';
import 'one_tab.dart';
import 'context_sheet.dart';
import 'window_sheet.dart';
import 'permission_sheet.dart';
import 'window_tab.dart';

class ChatRoute extends StatefulWidget {
  const ChatRoute({
    super.key,
    required this.link,
    required this.port,
    required this.root,
    this.seen,
    this.onTab,
    this.retry,
  });

  final HostLink link;
  final int port;
  final String root;

  /// Told the window's replies while the chat is open, so the list shows none of them unread.
  final Seen? seen;

  /// for tests: the tab once made
  final void Function(WindowTab tab)? onTab;
  final Future<void> Function(Duration)? retry;

  @override
  State<ChatRoute> createState() => _ChatRouteState();
}

class _ChatRouteState extends State<ChatRoute> {
  late final WindowTab _tab = WindowTab(
    widget.link,
    widget.port,
    widget.root,
    retry: widget.retry,
  );
  PermissionWatcher? _asks;
  final _draft = TextEditingController();
  final _panes = PanesController();
  final _focus_ = ChatFocus();
  final _filesNav = GlobalKey<NavigatorState>();
  final _depth = PaneDepth();
  final _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    widget.onTab?.call(_tab);
    widget.link.addListener(_see);
    _tab.addListener(_see);
    _see();
  }

  /// While the tab is open, the window's replies count as seen.
  void _see() {
    final seen = widget.seen;
    if (seen == null || _tab.state != TabState.open) return;
    final w = widget.link.windows
        .where((w) => w.port == widget.port && w.root == widget.root)
        .firstOrNull;
    final session = w?.session, replies = w?.replies;
    if (session == null || replies == null) return;
    unawaited(seen.see(widget.link.host.id, session, replies));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _asks ??= PermissionWatcher(_tab, context);
  }

  @override
  void dispose() {
    widget.link.removeListener(_see);
    _tab.removeListener(_see);
    _asks?.dispose();
    _tab.dispose();
    _draft.dispose();
    _depth.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Reply: the quote goes after what is already typed, and the field is focused with the caret behind it.
  void _reply(String quote) {
    final had = _draft.text;
    final sep = had.isEmpty || had.endsWith('\n') ? '' : '\n';
    final text = '$had$sep$quote';
    _draft.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _focus.requestFocus();
  }

  Widget? _item(BuildContext context, FeedItem it) {
    if (it is! PermissionItem) return null;
    if (it.prompt != null) return PromptCard(item: it, tab: _tab);
    if (it.answer != null || it.archived) return null;
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        onPressed: () => _asks?.open(it),
        icon: Icon(Icons.help_outline, color: c.accent, size: 18),
        label: Text(
          t.permissionAsked(it.toolName),
          style: TextStyle(color: c.accent),
        ),
      ),
    );
  }

  /// A comment on a message was tapped in the comments pane: the chat comes back and scrolls to it.
  Future<void> _toMessage(String id) async {
    _panes.show(Pane.chat);
    await Future<void>.delayed(const Duration(milliseconds: 300));
    if (mounted) await _focus_.scrollTo(id);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _tab,
    builder: (context, _) => Scaffold(
      body: ChatPanes(
        tab: _tab,
        controller: _panes,
        filesNavigator: _filesNav,
        depth: _depth,
        header: ChatHeader(
          tab: _tab,
          onTapTitle: () => showWindowSheet(context, _tab),
          onTapRing: () => showContextSheet(context, _tab),
        ),
        chat: (wide, top) => ChatScreen(
          tab: _tab,
          showHeader: wide,
          extraTop: top,
          focus: _focus_,
          onTapTitle: () => showWindowSheet(context, _tab),
          onTapRing: () => showContextSheet(context, _tab),
          bottom: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CommentStrip(tab: _tab),
              Composer(tab: _tab, controller: _draft, focus: _focus),
            ],
          ),
          overlay: OneTabOverlay(tab: _tab),
          itemBuilder: _item,
          onReply: _reply,
        ),
        files: (top) => FilesPane(
          tab: _tab,
          navigatorKey: _filesNav,
          observers: [_depth],
          topInset: top,
        ),
        comments: (top) =>
            CommentsPane(tab: _tab, topInset: top, onChat: _toMessage),
      ),
    ),
  );
}
