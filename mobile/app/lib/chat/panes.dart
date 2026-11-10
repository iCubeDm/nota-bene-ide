// The chat as three panes in a row, like the desktop's file tree and comments beside the chat: Files <- Chat ->
// Comments, Chat in the middle and shown first. A narrow screen shows one at a time under the floating header, with a
// strip of tabs like Telegram's chat folders (a sliding underline that follows the swipe) and a horizontal swipe across
// the screen to change; a wide one (landscape, a tablet) stands the three side by side. Back on Files goes up a folder
// first, then, like back on Comments, returns to the chat.
import 'package:flutter/material.dart';

import '../comments/comments.dart' show Comments;
import '../l10n/app_localizations.dart';
import '../theme.dart';
import '../ui/folder_tabs.dart';
import '../voice/recorder.dart' show Microphone;
import 'window_tab.dart';

enum Pane { files, chat, comments }

/// Switches the panes from outside the shell (the agent menu's Files, a comment that points into the chat).
class PanesController {
  void Function(Pane)? _show;
  void show(Pane p) => _show?.call(p);
}

/// From this width the three panes stand side by side.
const widePanes = 840.0;

class ChatPanes extends StatefulWidget {
  const ChatPanes({
    super.key,
    required this.tab,
    required this.controller,
    required this.header,
    required this.chat,
    required this.files,
    required this.comments,
    required this.filesNavigator,
  });
  final WindowTab tab;
  final PanesController controller;

  /// The floating header (narrow: above the panes).
  final Widget header;

  /// The chat; `wide` puts the header inside it and `top` is the room to keep clear above the feed (the strip).
  final Widget Function(bool wide, double top) chat;
  final Widget Function(double top) files;
  final Widget Function(double top) comments;

  /// The Files pane's own navigator: back goes up a folder before it leaves the pane.
  final GlobalKey<NavigatorState> filesNavigator;

  @override
  State<ChatPanes> createState() => _ChatPanesState();
}

class _ChatPanesState extends State<ChatPanes> {
  final _page = PageController(initialPage: 1);
  Pane _current = Pane.chat;

  /// The height of the strip of tabs.
  static const stripHeight = 40.0;

  /// The floating header with its margins (8 + 40 + 8), under which the strip sits.
  static const headerBox = 56.0;

  @override
  void initState() {
    super.initState();
    widget.controller._show = _show;
  }

  @override
  void didUpdateWidget(ChatPanes old) {
    super.didUpdateWidget(old);
    widget.controller._show = _show;
  }

  @override
  void dispose() {
    if (widget.controller._show == _show) widget.controller._show = null;
    _page.dispose();
    super.dispose();
  }

  void _show(Pane p) {
    if (_page.hasClients) {
      _page.animateToPage(
        p.index,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOutCubic,
      );
    }
    setState(() => _current = p);
  }

  /// Back: a folder up in Files, then to the chat.
  void _back() {
    if (_current == Pane.files) {
      final nav = widget.filesNavigator.currentState;
      if (nav != null && nav.canPop()) {
        nav.pop();
        return;
      }
    }
    _show(Pane.chat);
  }

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= widePanes;
    if (wide) {
      return Row(
        children: [
          Expanded(
            flex: 3,
            child: widget.files(MediaQuery.paddingOf(context).top),
          ),
          const VerticalDivider(width: 1),
          Expanded(flex: 5, child: widget.chat(true, 0)),
          const VerticalDivider(width: 1),
          Expanded(
            flex: 3,
            child: widget.comments(MediaQuery.paddingOf(context).top),
          ),
        ],
      );
    }
    final c = Theme.of(context).extension<NbColors>()!;
    final top = MediaQuery.paddingOf(context).top;
    // the header floats (8 + 40 + 8), the strip under it
    final cover = top + headerBox + stripHeight;
    return PopScope(
      canPop: _current == Pane.chat,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Stack(
        children: [
          Positioned.fill(
            child: ValueListenableBuilder<bool>(
              valueListenable: Microphone.hot,
              builder: (context, recording, _) => PageView(
                controller: _page,
                // a finger sliding on the microphone is the recording's, not a swipe
                physics: recording
                    ? const NeverScrollableScrollPhysics()
                    : const PageScrollPhysics(),
                onPageChanged: (i) => setState(() => _current = Pane.values[i]),
                children: [
                  widget.files(cover),
                  widget.chat(false, headerBox + stripHeight),
                  widget.comments(cover),
                ],
              ),
            ),
          ),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(bottom: false, child: widget.header),
          ),
          Positioned(
            top: top + headerBox,
            left: 0,
            right: 0,
            height: stripHeight,
            child: Material(
              color: c.background.withValues(alpha: 0.92),
              child: PaneStrip(
                page: _page,
                pending: widget.tab.comments,
                onTap: _show,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The tabs: three labels, an underline that slides with the page, a count badge on Comments.
class PaneStrip extends StatelessWidget {
  const PaneStrip({
    super.key,
    required this.page,
    required this.pending,
    required this.onTap,
  });
  final PageController page;
  final Comments pending;
  final void Function(Pane) onTap;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([page, pending]),
      builder: (context, _) => FolderTabs(
        labels: [t.tabFiles, t.tabChat, t.tabComments],
        at: page.hasClients && page.position.haveDimensions
            ? (page.page ?? 1.0)
            : 1.0,
        badges: {2: pending.pending.length},
        onTap: (i) => onTap(Pane.values[i]),
      ),
    );
  }
}
