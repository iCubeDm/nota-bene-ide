// A subagent's conversation (issue 573), as the desktop's subagent tab (web/src/plugins/subagent/AgentView.tsx): read
// only, drawn from `/subagent`'s events by the chat's own feed. Read when it opens, then every 1.5 s while the
// subagent works (the window says it runs, and a live task of its call or its call having no result says so too) and
// the screen is up. A subagent not in this session, or a failed read, is said in a line and tried again with a backoff.
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../chat/bubbles.dart';
import '../chat/feed.dart';
import '../chat/files.dart';
import '../chat/tool_group.dart';
import '../chat/window_tab.dart';
import '../comments/strings.g.dart';
import '../files/repository.dart';
import '../theme.dart';
import 'poll.dart';

const agentPoll = Duration(milliseconds: 1500);
const _backoffMax = Duration(seconds: 30);

class AgentScreen extends StatefulWidget {
  const AgentScreen({
    super.key,
    required this.tab,
    required this.tool,
    required this.title,
  });
  final WindowTab tab;

  /// The Agent call's tool-use id.
  final String tool;
  final String title;

  @override
  State<AgentScreen> createState() => _AgentScreenState();
}

class _AgentScreenState extends State<AgentScreen> {
  late final Poll _poll = Poll(_read);
  Feed? _feed;
  bool _running = false, _gone = false;
  String _name = '';
  String? _error;
  Duration _fails = Duration.zero;

  @override
  void initState() {
    super.initState();
    _poll;
  }

  /// Something says the subagent works: a live task of its call, or its call has no result in the chat yet.
  bool get _pollable {
    final tool = widget.tool;
    final live = widget.tab.tasks.state.values.any(
      (x) => x.call == tool && x.running,
    );
    return live ||
        !widget.tab.windowState.feed.items.any(
          (i) => i is ToolItem && i.id == tool && i.result != null,
        );
  }

  Duration _backoff() {
    _fails = _fails == Duration.zero ? agentPoll * 2 : _fails * 2;
    return Duration(
      milliseconds: math.min(_fails.inMilliseconds, _backoffMax.inMilliseconds),
    );
  }

  Future<Duration?> _read() async {
    final session = widget.tab.windowState.feed.sessionId;
    if (session == null) return _backoff();
    try {
      final v = await widget.tab.repository.subagent(session, widget.tool);
      if (!mounted) return null;
      final f = Feed();
      for (final e in v.events) {
        f.apply(e);
      }
      setState(() {
        _feed = f;
        _running = v.running;
        _name = v.description.isNotEmpty ? v.description : v.type;
        _gone = false;
        _error = null;
      });
      if (!v.running || !_pollable) return null;
      _fails = Duration.zero;
      return agentPoll;
    } on FilesError catch (e) {
      if (!mounted) return null;
      final gone = e.status == 404 || e.status == 409;
      setState(() {
        _gone = gone;
        _error = gone
            ? null
            : (e.status == null ? '${e.cause ?? e}' : 'HTTP ${e.status}');
      });
      return gone || _pollable ? _backoff() : null;
    }
  }

  @override
  void dispose() {
    _poll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final feed = _feed;
    final muted = TextStyle(fontSize: 13, color: c.mutedFg);
    Widget note(String s, {Color? color}) => Padding(
      padding: const EdgeInsets.all(24),
      child: Text(
        s,
        textAlign: TextAlign.center,
        style: muted.copyWith(color: color),
      ),
    );
    final rows = feed == null ? const <FeedRow>[] : feedRows(feed.items);
    return Scaffold(
      appBar: AppBar(
        title: Text(
          _name.isNotEmpty ? _name : widget.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          if (feed != null && _running)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Center(
                child: Text(
                  webString(WebKey.agentRunning, lang),
                  style: TextStyle(fontSize: 12, color: c.accent),
                ),
              ),
            ),
        ],
      ),
      body: FileOpener(
        tab: widget.tab,
        child: _gone && feed == null
            ? note(webString(WebKey.agentGone, lang))
            : feed == null
            ? (_error != null
                  ? note(
                      batchTemplate(BatchKey.agentFailed, lang, [_error!]),
                      color: c.destructive,
                    )
                  : note(webString(WebKey.agentLoading, lang)))
            : ListView.builder(
                key: const ValueKey('agent-feed'),
                padding: const EdgeInsets.symmetric(vertical: 8),
                itemCount: rows.length + (_error != null ? 1 : 0),
                itemBuilder: (context, i) {
                  if (i == rows.length) {
                    return note(
                      batchTemplate(BatchKey.agentFailed, lang, [_error!]),
                      color: c.destructive,
                    );
                  }
                  final row = rows[i];
                  final it = row.items.first;
                  final inner = row.isGroup
                      ? ToolGroup(
                          items: row.items.cast<ToolItem>(),
                          live: _running && i == rows.length - 1,
                        )
                      : FeedItemView(it);
                  return KeyedSubtree(
                    key: ValueKey(row.key),
                    child: inAgentTurn(it)
                        ? AgentBubble(
                            first:
                                i == 0 || !inAgentTurn(rows[i - 1].items.last),
                            last:
                                i == rows.length - 1 ||
                                !inAgentTurn(rows[i + 1].items.first),
                            child: inner,
                          )
                        : inner,
                  );
                },
              ),
      ),
    );
  }
}
