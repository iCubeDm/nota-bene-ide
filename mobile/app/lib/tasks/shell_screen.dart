// A background shell task's output (issue 573), as the desktop's shell tab (web/src/plugins/tasks/ShellView.tsx): plain
// text in monospace, escape sequences removed. `/task-output` is read every second while the task runs and the screen
// is up; the read that says it ended (and one more once its end reaches the tasks) is the last.
import 'dart:convert';

import 'package:flutter/material.dart';

import '../chat/window_tab.dart';
import '../comments/strings.g.dart';
import '../files/repository.dart';
import '../theme.dart';
import '../usage/format.dart' show byteSize;
import 'ansi.dart';
import 'poll.dart';
import 'tasks.dart';
import 'tasks_sheet.dart';

const shellPoll = Duration(seconds: 1);
const _retry = Duration(seconds: 3);

class ShellScreen extends StatefulWidget {
  const ShellScreen({
    super.key,
    required this.tab,
    required this.task,
    required this.title,
  });
  final WindowTab tab;
  final String task;
  final String title;

  @override
  State<ShellScreen> createState() => _ShellScreenState();
}

class _ShellScreenState extends State<ShellScreen> {
  late final Poll _poll = Poll(_read);
  ({String output, num totalBytes, bool truncated, bool running})? _out;
  bool _gone = false, _final = false;
  String? _error;
  late bool _ended;

  bool get _endedNow => !(widget.tab.tasks.state[widget.task]?.running ?? true);

  @override
  void initState() {
    super.initState();
    _ended = _endedNow;
    widget.tab.tasks.addListener(_tasks);
    _poll;
  }

  // the task's end reached the tasks first: one more read gets the end of its output
  void _tasks() {
    if (_endedNow && !_ended && !_final) _poll.kick();
    _ended = _endedNow;
    if (mounted) setState(() {});
  }

  Future<Duration?> _read() async {
    final session = widget.tab.windowState.feed.sessionId;
    if (session == null) return _retry;
    try {
      final v = await widget.tab.repository.taskOutput(session, widget.task);
      if (!mounted) return null;
      setState(() {
        _out = v;
        _error = null;
        _final = !v.running;
      });
      return v.running ? shellPoll : null;
    } on FilesError catch (e) {
      if (!mounted) return null;
      if (e.status == 404 || e.status == 409) {
        setState(() => _gone = _final = true);
        return null;
      }
      setState(
        () =>
            _error = e.status == null ? '${e.cause ?? e}' : 'HTTP ${e.status}',
      );
      return _retry;
    } on Object catch (e) {
      // an answer that is not a task's output
      if (!mounted) return null;
      setState(() => _error = '$e');
      return _retry;
    }
  }

  @override
  void dispose() {
    widget.tab.tasks.removeListener(_tasks);
    _poll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final info = widget.tab.tasks.state[widget.task];
    final out = _out;
    final running = info?.running ?? out?.running ?? true;
    final status =
        info?.status ??
        (out != null && !out.running ? TaskStatus.done : TaskStatus.running);
    final text = out == null
        ? ''
        : plainOutput(out.output, truncated: out.truncated);
    final earlier = out != null && out.truncated
        ? out.totalBytes - utf8.encode(out.output).length
        : 0;
    final muted = TextStyle(fontSize: 13, color: c.mutedFg);
    Widget note(String s, {Color? color}) => Padding(
      padding: const EdgeInsets.all(24),
      child: Text(
        s,
        textAlign: TextAlign.center,
        style: muted.copyWith(color: color),
      ),
    );
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          Center(
            child: Text(
              _gone
                  ? webString(WebKey.shellGoneShort, lang)
                  : statusWord(status, lang),
              key: const ValueKey('shell-status'),
              style: TextStyle(
                fontSize: 12,
                color: running ? c.accent : c.mutedFg,
              ),
            ),
          ),
          if (taskControls(widget.tab) && running && !_gone) ...[
            const SizedBox(width: 8),
            StopButton(
              tab: widget.tab,
              id: widget.task,
              refusals: widget.tab.tasks.refusals,
            ),
          ],
          const SizedBox(width: 12),
        ],
      ),
      body: _gone
          ? note(webString(WebKey.shellGone, lang))
          : out == null
          ? (_error != null
                ? note(
                    batchTemplate(BatchKey.shellFailed, lang, [_error!]),
                    color: c.destructive,
                  )
                : note(webString(WebKey.shellLoading, lang)))
          : SingleChildScrollView(
              reverse: true, // sticks to the end while it is there
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        batchTemplate(BatchKey.shellStale, lang, [_error!]),
                        style: TextStyle(fontSize: 12, color: c.destructive),
                      ),
                    ),
                  if (earlier > 0)
                    Text(
                      batchTemplate(BatchKey.shellEarlier, lang, [
                        byteSize(earlier, lang),
                      ]),
                      style: muted.copyWith(fontSize: 11),
                    ),
                  SelectableText(
                    text.isEmpty ? webString(WebKey.shellEmpty, lang) : text,
                    key: const ValueKey('shell-output'),
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12.5,
                      height: 1.45,
                      color: c.foreground,
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}
