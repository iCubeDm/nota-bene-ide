// The chat's background tasks (issue 573), as the desktop's tasks drawer (web/src/plugins/tasks/): the header's count,
// a sheet of the running tasks and the last finished, nested by parent, swarm and workflow, with Stop and To background,
// and a tap that opens a subagent's conversation or a shell's output.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../comments/strings.g.dart';
import '../theme.dart';
import '../usage/format.dart' show fmtTokens;
import 'agent_screen.dart';
import 'shell_screen.dart';
import 'tasks.dart';

/// How long Stop stays on "Stop?" before it goes back.
const stopConfirm = Duration(seconds: 3);

/// How long a sent Stop waits for its answer before it is offered again.
const stopWait = Duration(seconds: 5);

/// The window has the task controls (stop, to background, a shell's output).
bool taskControls(WindowTab tab) => tab.connection.has(Feature.taskControl);

/// Whether [x]'s view opens here: a subagent's conversation or a shell's output, on a window that serves it.
bool canOpenTask(WindowTab tab, Task x) => switch (x.kind) {
  TaskKind.agent =>
    x.type != 'remote_agent' &&
        x.call != null &&
        tab.connection.has(Feature.subagentAnchors),
  TaskKind.shell =>
    taskControls(tab) && tab.windowState.capabilities?.taskOutput != false,
  _ => false,
};

/// Opens [x]'s view over the chat.
void openTask(BuildContext context, WindowTab tab, String id, Task x) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => x.kind == TaskKind.agent
            ? AgentScreen(tab: tab, tool: x.call!, title: x.desc)
            : ShellScreen(tab: tab, task: id, title: x.desc),
      ),
    );

/// The status's mark and colour, as the drawer's.
(String, Color) statusMark(NbColors c, TaskStatus s) => switch (s) {
  TaskStatus.running => ('●', c.accent),
  TaskStatus.done => ('✓', c.success),
  TaskStatus.failed => ('✕', c.destructive),
  TaskStatus.stopped => ('■', c.mutedFg),
};

String statusWord(TaskStatus s, String lang) => webString(switch (s) {
  TaskStatus.running => WebKey.taskRunning,
  TaskStatus.done => WebKey.taskDone,
  TaskStatus.failed => WebKey.taskFailed,
  TaskStatus.stopped => WebKey.taskStopped,
}, lang);

/// The header's count: `⚙ N` while some run, `✓ N` when only finished ones are left, the watchers when only they
/// run, nothing when there are none; a screen reader hears the phrase. A tap opens the sheet.
class TasksIndicator extends StatelessWidget {
  const TasksIndicator({super.key, required this.tab, required this.fill});
  final WindowTab tab;
  final Color fill;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: tab.tasks,
    builder: (context, _) {
      final c = Theme.of(context).extension<NbColors>()!;
      final lang = Localizations.localeOf(context).languageCode;
      final s = tab.tasks.state;
      final running = runningCount(s), finished = finishedCount(s);
      final watchers = watcherCount(s);
      if (running + finished + watchers == 0) return const SizedBox.shrink();
      final (mark, color, n, label) = running > 0
          ? (
              '⚙',
              c.accent,
              running,
              webCount(CountKey.tasksRunning, lang, running),
            )
          : finished > 0
          ? ('✓', c.success, finished, webString(WebKey.tasksLabel, lang))
          : (
              '⚙',
              c.mutedFg,
              watchers,
              webCount(CountKey.tasksWatchers, lang, watchers),
            );
      return Padding(
        padding: const EdgeInsets.only(left: 8),
        child: Semantics(
          button: true,
          label: label,
          excludeSemantics: true,
          child: Material(
            key: const ValueKey('tasks-indicator'),
            color: fill,
            shape: StadiumBorder(side: BorderSide(color: c.border)),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: () => showTasksSheet(context, tab),
              child: Container(
                height: 40,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                alignment: Alignment.center,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(mark, style: TextStyle(fontSize: 13, color: color)),
                    const SizedBox(width: 6),
                    Text(
                      '$n',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: running > 0 ? c.accent : c.foreground,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
}

Future<void> showTasksSheet(BuildContext context, WindowTab tab) {
  final c = Theme.of(context).extension<NbColors>()!;
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: c.popover,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => TasksSheet(tab: tab, outer: context),
  );
}

/// The sheet of tasks: one row per task (a task launched by a subagent nested under it) and one per swarm (its agents
/// under it). It reads the tasks and, for To background, the chat; while one runs it ticks for the elapsed times.
class TasksSheet extends StatefulWidget {
  const TasksSheet({super.key, required this.tab, required this.outer});
  final WindowTab tab;

  /// The chat's context: a task's view opens through it after the sheet closes.
  final BuildContext outer;

  @override
  State<TasksSheet> createState() => _TasksSheetState();
}

class _TasksSheetState extends State<TasksSheet> {
  Timer? _tick;
  Set<String> _resulted = const {};

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  void _ticking(bool on) {
    if (on == (_tick != null)) return;
    _tick?.cancel();
    _tick = on
        ? Timer.periodic(const Duration(seconds: 1), (_) {
            if (mounted) setState(() {});
          })
        : null;
  }

  @override
  Widget build(BuildContext context) {
    final tab = widget.tab;
    return ListenableBuilder(
      listenable: Listenable.merge([tab.tasks, tab]),
      builder: (context, _) {
        final c = Theme.of(context).extension<NbColors>()!;
        final lang = Localizations.localeOf(context).languageCode;
        final s = tab.tasks.state;
        _ticking(runningCount(s) > 0);
        final rows = taskRows(s);
        final now = tab.tasks.now();
        // once per build, not once per row: the sheet rebuilds with every chunk of a reply
        _resulted = resultedCalls(tab.windowState.feed);
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * 0.7,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 8),
                Center(
                  child: Container(
                    width: 36,
                    height: 4,
                    decoration: BoxDecoration(
                      color: c.border,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                  child: Text(
                    webString(WebKey.tasksLabel, lang),
                    style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                      color: c.foreground,
                    ),
                  ),
                ),
                if (rows.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
                    child: Text(
                      webString(WebKey.tasksNone, lang),
                      style: TextStyle(fontSize: 13, color: c.mutedFg),
                    ),
                  )
                else
                  Flexible(
                    child: ListView(
                      shrinkWrap: true,
                      padding: const EdgeInsets.only(bottom: 12),
                      children: [
                        for (final r in rows)
                          r.group != null
                              ? _groupRow(context, r, now, lang)
                              : _taskRow(context, r, now, lang),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _row(
    BuildContext context, {
    required Key key,
    required int depth,
    required TaskStatus status,
    required String title,
    required String meta,
    bool bold = false,
    List<Widget> actions = const [],
    VoidCallback? onTap,
  }) {
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final (mark, color) = statusMark(c, status);
    return InkWell(
      key: key,
      onTap: onTap,
      child: Padding(
        padding: EdgeInsets.fromLTRB(16.0 + depth * 16, 8, 12, 8),
        child: Row(
          children: [
            SizedBox(
              width: 18,
              child: Semantics(
                label: statusWord(status, lang),
                child: ExcludeSemantics(
                  child: Text(
                    mark,
                    style: TextStyle(fontSize: 12, color: color),
                  ),
                ),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: bold ? FontWeight.w600 : FontWeight.w400,
                      color: c.foreground,
                    ),
                  ),
                  if (meta.isNotEmpty)
                    Text(
                      meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 11.5,
                        fontFamily: 'monospace',
                        color: c.mutedFg,
                      ),
                    ),
                ],
              ),
            ),
            for (final a in actions) ...[const SizedBox(width: 6), a],
          ],
        ),
      ),
    );
  }

  Widget _groupRow(BuildContext context, TaskRow r, int now, String lang) {
    final g = r.group!;
    final tab = widget.tab;
    final meta = [
      fmtElapsed((g.end ?? now) - g.start),
      if (g.tokens > 0)
        batchTemplate(BatchKey.taskTokens, lang, [fmtTokens(g.tokens, lang)]),
      [
        batchTemplate(BatchKey.taskGroupDone, lang, [g.done, g.total]),
        if (g.failed > 0) webCount(CountKey.taskGroupFailed, lang, g.failed),
        if (g.stopped > 0) webCount(CountKey.taskGroupStopped, lang, g.stopped),
      ].join(', '),
    ].join(' · ');
    return _row(
      context,
      key: ValueKey('task-group:${r.id}'),
      depth: r.depth,
      status: g.status,
      title: webCount(CountKey.taskGroup, lang, g.total),
      meta: meta,
      bold: true,
      actions: [
        if (taskControls(tab) && g.live.isNotEmpty)
          StopButton(
            tab: tab,
            id: r.id,
            members: g.live,
            refusals: tab.tasks.refusals,
          ),
      ],
    );
  }

  Widget _taskRow(BuildContext context, TaskRow r, int now, String lang) {
    final x = r.task!;
    final tab = widget.tab;
    final meta = [
      if (x.workflow case final w?)
        batchTemplate(BatchKey.taskWorkflow, lang, [w])
      else
        x.type,
      if (x.model case final m?) shortModel(m),
      fmtElapsed((x.end ?? now) - x.start),
      if (x.tokens > 0)
        batchTemplate(BatchKey.taskTokens, lang, [fmtTokens(x.tokens, lang)]),
      x.tool,
      x.summary,
    ].where((p) => p.isNotEmpty).join(' · ');
    final open = canOpenTask(tab, x);
    return _row(
      context,
      key: ValueKey('task:${r.id}'),
      depth: r.depth,
      status: x.status,
      title: x.desc,
      meta: meta,
      onTap: open
          ? () {
              Navigator.of(context).pop();
              openTask(widget.outer, tab, r.id, x);
            }
          : null,
      actions: [
        if (taskControls(tab) && x.running && !x.inner)
          StopButton(tab: tab, id: r.id, refusals: tab.tasks.refusals),
        if (x.running) BackgroundButton(tab: tab, task: x, resulted: _resulted),
      ],
    );
  }
}

/// A small text button of a task's row.
class _TaskButton extends StatelessWidget {
  const _TaskButton({
    required this.label,
    required this.onTap,
    this.danger = false,
  });
  final String label;
  final VoidCallback? onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final fg = danger ? c.destructive : c.foreground;
    return Opacity(
      opacity: onTap == null ? 0.6 : 1,
      child: OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          foregroundColor: fg,
          disabledForegroundColor: fg,
          side: BorderSide(color: danger ? c.destructive : c.border),
          minimumSize: const Size(0, 32),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          textStyle: const TextStyle(fontSize: 12),
        ),
        child: Text(label),
      ),
    );
  }
}

/// Stop, confirmed in place: the first tap turns it into "Stop?" for [stopConfirm], a second one stops the task. Sent,
/// it waits for the task to end, the window's refusal ([refusals] grows) or [stopWait]. With [members] it is a swarm's
/// Stop all: [id] names the row, the members are what it stops.
class StopButton extends StatefulWidget {
  const StopButton({
    super.key,
    required this.tab,
    required this.id,
    required this.refusals,
    this.members,
  });
  final WindowTab tab;
  final String id;
  final int refusals;
  final List<String>? members;

  @override
  State<StopButton> createState() => _StopButtonState();
}

class _StopButtonState extends State<StopButton> {
  bool _sure = false, _pending = false;
  Timer? _timer;

  void _reset() {
    _timer?.cancel();
    _sure = _pending = false;
  }

  @override
  void didUpdateWidget(StopButton old) {
    super.didUpdateWidget(old);
    if (old.id != widget.id || old.refusals != widget.refusals) _reset();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _later(Duration d) {
    _timer?.cancel();
    _timer = Timer(d, () {
      if (mounted) setState(_reset);
    });
  }

  void _tap() {
    if (!_sure) {
      setState(() => _sure = true);
      return _later(stopConfirm);
    }
    var sent = true;
    for (final id in widget.members ?? [widget.id]) {
      sent = widget.tab.connection.send(ClientMessageTaskStop(id: id)) && sent;
    }
    // not gone (the socket is down): nothing to wait for, Stop stays to try again
    setState(() {
      _sure = false;
      _pending = sent;
    });
    if (sent) _later(stopWait);
  }

  @override
  Widget build(BuildContext context) {
    final lang = Localizations.localeOf(context).languageCode;
    if (_pending) {
      return _TaskButton(
        label: webString(WebKey.taskStopping, lang),
        onTap: null,
      );
    }
    final all = widget.members != null;
    return _TaskButton(
      label: webString(
        all
            ? (_sure ? WebKey.taskStopAllConfirm : WebKey.taskStopAll)
            : (_sure ? WebKey.taskStopConfirm : WebKey.taskStop),
        lang,
      ),
      danger: _sure,
      onTap: _tap,
    );
  }
}

/// To background: only for a task in the foreground ([foreground]), and only on a window that has it.
class BackgroundButton extends StatelessWidget {
  const BackgroundButton({
    super.key,
    required this.tab,
    required this.task,
    required this.resulted,
  });
  final WindowTab tab;
  final Task task;

  /// [resultedCalls] of the chat.
  final Set<String> resulted;

  @override
  Widget build(BuildContext context) {
    final call = task.call;
    if (call == null ||
        !taskControls(tab) ||
        tab.windowState.capabilities?.taskBackground == false ||
        !foreground(task, tab.windowState.feed, resulted)) {
      return const SizedBox.shrink();
    }
    return _TaskButton(
      label: webString(
        WebKey.taskBackground,
        Localizations.localeOf(context).languageCode,
      ),
      onTap: () =>
          tab.connection.send(ClientMessageTaskBackground(toolUseId: call)),
    );
  }
}
