// The window's background tasks (issue 573): a port of the desktop's task reducer (shared/src/tasks.ts) and of the
// drawer's rows and counts (web/src/plugins/tasks/slice.ts), held to them by test/fixtures/tasks, which
// web/src/plugins/tasks/mobileParity.test.ts writes. [Tasks] keeps them for a window and tells only when they change.
import 'package:flutter/foundation.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/feed.dart';

enum TaskStatus { running, done, failed, stopped }

/// `agent`: a subagent; `shell`: a background shell or Monitor (has an output to read); `workflow`: a workflow run.
enum TaskKind { agent, shell, workflow, other }

/// The kind from the CLI's task_type (local_agent, local_bash, monitor_mcp, ...); no type but a call: an agent.
TaskKind taskKind(String type, String? call) {
  if (type.contains('agent')) return TaskKind.agent;
  if (RegExp('bash|shell|monitor').hasMatch(type)) return TaskKind.shell;
  if (type.contains('workflow')) return TaskKind.workflow;
  return type.isEmpty && call != null ? TaskKind.agent : TaskKind.other;
}

/// A model for a row: `claude-sonnet-5-5` is "Sonnet 5.5", an alias such as `sonnet` "Sonnet"; any other id as given.
String shortModel(String id) {
  final m = RegExp(
    r'^claude-(opus|sonnet|haiku|fable)(?:-(\d+))?(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$',
  ).firstMatch(id);
  String cap(String s) => '${s[0].toUpperCase()}${s.substring(1)}';
  if (m != null) {
    return '${cap(m[1]!)}${m[2] != null ? ' ${m[2]}${m[3] != null ? '.${m[3]}' : ''}' : ''}';
  }
  return RegExp(r'^(opus|sonnet|haiku|fable)$').hasMatch(id) ? cap(id) : id;
}

/// `Ns` under a minute, else `m:ss`.
String fmtElapsed(num ms) {
  final secs = (ms / 1000).round().clamp(0, 1 << 62);
  return secs >= 60
      ? '${secs ~/ 60}:${(secs % 60).toString().padLeft(2, '0')}'
      : '${secs}s';
}

class Task {
  const Task({
    required this.desc,
    required this.type,
    required this.kind,
    this.call,
    this.parent,
    this.group,
    this.workflow,
    this.inner = false,
    this.bg,
    this.ambient = false,
    required this.start,
    required this.status,
    this.end,
    this.tokens = 0,
    this.tool = '',
    this.summary = '',
    this.model,
  });

  final String desc, type;
  final TaskKind kind;

  /// the tool-use id of the call that started it; the task_id of the subagent task that launched it; the model
  /// response that launched it (tasks of one response are a swarm); a workflow's name
  final String? call, parent, group, workflow;

  /// runs inside its parent's run (a workflow's agent): no stop, no transcript, not counted
  final bool inner;

  /// the CLI's `is_backgrounded`: false blocks its tool call, true runs in the background; null = not said
  final bool? bg;

  /// a live-update watcher: listed, not counted as activity
  final bool ambient;

  /// the window's times (ms) it started and, once over, ended
  final num start;
  final num? end;
  final TaskStatus status;
  final num tokens;
  final String tool, summary;
  final String? model;

  bool get running => status == TaskStatus.running;

  Task _with({
    String? desc,
    bool? bg,
    String? model,
    TaskStatus? status,
    num? end,
    num? tokens,
    String? tool,
    String? summary,
  }) => Task(
    desc: desc ?? this.desc,
    type: type,
    kind: kind,
    call: call,
    parent: parent,
    group: group,
    workflow: workflow,
    inner: inner,
    bg: bg ?? this.bg,
    ambient: ambient,
    start: start,
    status: status ?? this.status,
    end: end ?? this.end,
    tokens: tokens ?? this.tokens,
    tool: tool ?? this.tool,
    summary: summary ?? this.summary,
    model: model ?? this.model,
  );

  /// As the desktop's state holds it (the fixtures' shape).
  Map<String, Object?> toJson() => {
    'desc': desc,
    'type': type,
    'kind': kind.name,
    'call': ?call,
    'parent': ?parent,
    'group': ?group,
    'workflow': ?workflow,
    'bg': ?bg,
    'model': ?model,
    if (ambient) 'ambient': true,
    if (inner) 'inner': true,
    'start': start,
    'status': status.name,
    'end': ?end,
    'tokens': tokens,
    'tool': tool,
    'summary': summary,
  };
}

/// task_id → task: the running ones and the last [finishedCap] finished. Never changed in place.
typedef TasksState = Map<String, Task>;

/// The most finished tasks kept (a workflow's agents go first, then the oldest ended).
const finishedCap = 20;

/// [list] sorted by [cmp], equal ones kept in their order (as JavaScript's sort does).
List<T> _stable<T>(Iterable<T> list, int Function(T, T) cmp) {
  final indexed = list.indexed.toList()
    ..sort((a, b) {
      final c = cmp(a.$2, b.$2);
      return c != 0 ? c : a.$1 - b.$1;
    });
  return [for (final (_, x) in indexed) x];
}

/// The running tasks, oldest first, then the finished, newest ended first.
List<MapEntry<String, Task>> orderedTasks(TasksState s) => [
  ..._stable(
    s.entries.where((e) => e.value.running),
    (a, b) => a.value.start.compareTo(b.value.start),
  ),
  ..._stable(
    s.entries.where((e) => !e.value.running),
    (a, b) => (b.value.end ?? 0).compareTo(a.value.end ?? 0),
  ),
];

/// An optional string the desktop drops when it is empty.
String? _s(String? v) => v == null || v.isEmpty ? null : v;

/// Takes event [ev]: the same map back when it changes nothing. `ts` is the window's event time.
TasksState reduceTasks(TasksState s, ServerEvent ev) {
  if (ev is ServerEventReplay) return ev.events.fold(const {}, reduceTasks);
  if (ev is! ServerEventAgent) return s;
  final e = ev.e;
  if (e is WireAgentEventReset) return s.isEmpty ? s : const {};
  if (e is! WireAgentEventTask) return s;
  final cur = s[e.id];
  switch (e.phase) {
    case WireAgentEventTaskPhase.started:
      // another start of a known id is a resume (SendMessage to a finished agent): the original call, parent, group
      // and bg stay
      final type = e.type ?? '';
      final call = cur?.call ?? _s(e.call);
      return {
        ...s,
        e.id: Task(
          desc: e.desc ?? 'task',
          type: type,
          kind: taskKind(type, call),
          call: call,
          parent: cur?.parent ?? _s(e.parent),
          group: cur?.group ?? _s(e.group),
          // an empty one said again drops the old, as the web's spread does
          workflow: e.workflow != null ? _s(e.workflow) : cur?.workflow,
          bg: e.bg ?? cur?.bg,
          model: e.model != null ? _s(e.model) : cur?.model,
          ambient: e.ambient == true,
          inner: e.inner == true || (cur?.inner ?? false),
          start: ev.ts,
          status: TaskStatus.running,
        ),
      };
    case WireAgentEventTaskPhase.progress:
      if (cur == null || !cur.running) return s;
      return {
        ...s,
        e.id: cur._with(
          tokens: e.tokens ?? 0,
          tool: e.tool ?? '',
          summary: e.summary ?? '',
          model: _s(e.model),
        ),
      };
    case WireAgentEventTaskPhase.updated:
      final desc = _s(e.desc), model = _s(e.model);
      if (cur == null || (desc == null && e.bg == null && model == null)) {
        return s;
      }
      return {...s, e.id: cur._with(desc: desc, bg: e.bg, model: model)};
    case WireAgentEventTaskPhase.done:
      // unknown, or already over (the CLI reports an end twice)
      if (cur == null || !cur.running) return s;
      final next = {
        ...s,
        e.id: cur._with(
          status: switch (e.status) {
            WireAgentEventTaskStatus.failed => TaskStatus.failed,
            WireAgentEventTaskStatus.stopped => TaskStatus.stopped,
            _ => TaskStatus.done,
          },
          end: ev.ts,
        ),
      };
      final finished = next.entries.where((x) => !x.value.running).toList();
      if (finished.length <= finishedCap) return next;
      final drop = _stable(
        finished,
        (a, b) => a.value.inner != b.value.inner
            ? (a.value.inner ? -1 : 1)
            : (a.value.end ?? 0).compareTo(b.value.end ?? 0),
      ).take(finished.length - finishedCap).map((x) => x.key).toSet();
      return next..removeWhere((k, _) => drop.contains(k));
    case WireAgentEventTaskPhase.$unknown:
      return s;
  }
}

/// How many tasks run (a workflow's agents count as their workflow; watchers not at all).
int runningCount(TasksState s) =>
    s.values.where((x) => x.running && !x.ambient && !x.inner).length;

/// Running watchers: only they exist => the indicator shows a quiet variant, so the list stays reachable.
int watcherCount(TasksState s) =>
    s.values.where((x) => x.running && x.ambient).length;

/// Finished tasks, not counting watchers and a workflow's agents.
int finishedCount(TasksState s) =>
    s.values.where((x) => !x.running && !x.ambient && !x.inner).length;

/// A swarm: the agents one model response launched, as one row; [live] are the running members, what Stop all stops.
class TaskGroup {
  TaskGroup._(this.key, List<MapEntry<String, Task>> members)
    : ids = [for (final m in members) m.key],
      live = [
        for (final m in members)
          if (m.value.running) m.key,
      ],
      total = members.length,
      tokens = members.fold<num>(0, (a, m) => a + m.value.tokens),
      start = members.map((m) => m.value.start).reduce((a, b) => a < b ? a : b),
      _counts = {
        for (final st in TaskStatus.values)
          st: members.where((m) => m.value.status == st).length,
      } {
    end = running > 0
        ? null
        : members
              .map((m) => m.value.end ?? m.value.start)
              .reduce((a, b) => a > b ? a : b);
  }

  final String key;
  final List<String> ids, live;
  final int total;
  final num tokens, start;
  late final num? end;
  final Map<TaskStatus, int> _counts;
  int get running => _counts[TaskStatus.running]!;
  int get done => _counts[TaskStatus.done]!;
  int get failed => _counts[TaskStatus.failed]!;
  int get stopped => _counts[TaskStatus.stopped]!;
  TaskStatus get status => running > 0
      ? TaskStatus.running
      : failed > 0
      ? TaskStatus.failed
      : stopped > 0
      ? TaskStatus.stopped
      : TaskStatus.done;

  Map<String, Object?> toJson() => {
    'key': key,
    'ids': ids,
    'live': live,
    'running': running,
    'done': done,
    'failed': failed,
    'stopped': stopped,
    'total': total,
    'status': status.name,
    'tokens': tokens,
    'start': start,
    'end': ?end,
  };
}

/// One row of the list: a task or a swarm's umbrella, [depth] levels in.
class TaskRow {
  const TaskRow(this.id, this.depth, {this.task, this.group});
  final String id;
  final int depth;
  final Task? task;
  final TaskGroup? group;
}

/// The rows: the running tasks (oldest first) then the finished (newest ended first); a task with a known parent task
/// is nested under it, whatever its own status; one whose parent is unknown stands on its own. Two or more agents of
/// one `group` under the same parent are a swarm: an umbrella row where its first member would stand.
List<TaskRow> taskRows(TasksState t) {
  // a finished parent with a running descendant is shown with the running rows
  final ordered0 = orderedTasks(t);
  final live = <String>{};
  for (final e in ordered0) {
    if (!e.value.running) continue;
    String? p = e.key;
    for (var n = 0; p != null && !live.contains(p) && n < 50; n++) {
      live.add(p);
      p = t[p]?.parent;
    }
  }
  final ordered = [
    ...ordered0.where((e) => live.contains(e.key)),
    ...ordered0.where((e) => !live.contains(e.key)),
  ];
  final kids = <String, List<MapEntry<String, Task>>>{};
  final roots = <MapEntry<String, Task>>[];
  for (final e in ordered) {
    final p = e.value.parent;
    if (p != null && p != e.key && t.containsKey(p)) {
      (kids[p] ??= []).add(e);
    } else {
      roots.add(e);
    }
  }
  final rows = <TaskRow>[];
  final seen = <String>{};
  late void Function(List<MapEntry<String, Task>>, int, String) level;
  void walk(MapEntry<String, Task> e, int depth) {
    if (!seen.add(e.key)) return; // a parent cycle (never sent) must not loop
    rows.add(TaskRow(e.key, depth, task: e.value));
    level(kids[e.key] ?? const [], depth + 1, e.key);
  }

  level = (list, depth, parent) {
    String? swarmOf(Task x) => x.kind == TaskKind.agent ? x.group : null;
    final swarms = <String, List<MapEntry<String, Task>>>{};
    for (final e in list) {
      if (swarmOf(e.value) case final g?) (swarms[g] ??= []).add(e);
    }
    for (final e in list) {
      final g = swarmOf(e.value);
      final members = g == null ? const <MapEntry<String, Task>>[] : swarms[g]!;
      if (members.length < 2) {
        walk(e, depth);
        continue;
      }
      if (members.first != e) continue;
      rows.add(
        TaskRow('group:$parent:$g', depth, group: TaskGroup._(g!, members)),
      );
      for (final m in members) {
        walk(m, depth + 1);
      }
    }
  };
  level(roots, 0, '');
  return rows;
}

/// "To background" is for a running task that blocks its tool call. The CLI says so ([Task.bg]); when it did not, the
/// call having no result yet in the chat stands in, and a task of the main thread is never in the foreground once its
/// turn is over. Nothing to send without the call's id.
/// [resulted]: [resultedCalls] of the feed, when the caller has it already.
bool foreground(Task x, Feed feed, [Set<String>? resulted]) {
  final call = x.call;
  if (!x.running || call == null) return false;
  if (x.bg case final bg?) return !bg;
  return !(resulted ?? resultedCalls(feed)).contains(call) &&
      (x.parent != null || feed.busy);
}

/// The ids of the tool calls of [feed] that have their result.
Set<String> resultedCalls(Feed feed) => {
  for (final i in feed.items)
    if (i is ToolItem && i.result != null) i.id,
};

/// A window's tasks, rebuilt from its replay and kept from its live events.
class Tasks extends ChangeNotifier {
  TasksState state = const {};

  /// How many task refusals the window sent (its `task` errors): a Stop waiting for its answer may be tried again.
  int refusals = 0;

  /// The phone's clock; replaced in tests.
  DateTime Function() clock = DateTime.now;

  /// The phone's clock minus the window's, as its last live event said (the task times are the window's).
  /// 0 until the first live event: until then the phone's clock stands in.
  int _skew = 0;

  /// The window's time now, in ms.
  int now() => clock().millisecondsSinceEpoch - _skew;

  bool _disposed = false;

  void apply(ServerEvent e) {
    if (e is ServerEventAgent) {
      _skew = clock().millisecondsSinceEpoch - e.ts.toInt();
    }
    if (e is ServerEventServerError && e.where == 'task') {
      refusals++;
      return _notify();
    }
    final next = reduceTasks(state, e);
    if (identical(next, state)) return;
    state = next;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
