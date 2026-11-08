// The chat's transcript, built from the window's events exactly as the desktop builds it: a port of
// web/src/store/feed.ts (reduce / reduceAgent). Mutable on purpose: a replay of thousands of events is applied once.
import 'package:nb_protocol/nb_protocol.dart';

sealed class FeedItem {}

class UserItem extends FeedItem {
  UserItem(
    this.id,
    this.text, {
    this.force = false,
    this.duringWork = false,
    this.idle = false,
    this.images = 0,
  });
  final String id, text;
  final bool force, duringWork;

  /// the server's own /compact after a quiet stretch: shown as a line, not as the user's message
  final bool idle;
  final int images;
}

class AssistantItem extends FeedItem {
  AssistantItem(this.id, this.text, {required this.final_});
  String id, text;

  /// false while the reply still streams
  bool final_;
}

class ToolItem extends FeedItem {
  ToolItem(this.id, this.name, this.arg, this.input, {required this.sub});
  final String id, name;

  /// the one-line summary of [input]
  final String arg;
  final Map<String, Object?> input;
  final bool sub;

  /// absent while the tool still runs
  String? result;
  bool isError = false;
}

enum MarkerKind { compacted, compactFailed, cleared }

class MarkerItem extends FeedItem {
  MarkerItem(this.what, this.key, {this.pre, this.error});
  final MarkerKind what;
  final String key;
  final num? pre;
  final String? error;
}

class DoneItem extends FeedItem {
  DoneItem(this.key, this.secs, this.status, {this.error});
  final String key;
  final num secs;
  final StopReason status;
  final String? error;
}

class PermissionItem extends FeedItem {
  PermissionItem(this.id, this.toolName, this.input, this.prompt);
  final String id, toolName;
  final Map<String, Object?> input;

  /// structured choices and fields (Codex, omp); null for a plain allow / deny
  final Interaction? prompt;
  bool? answer;

  /// from an earlier page of the history: nobody waits for its answer any more
  bool archived = false;
}

class ShellItem extends FeedItem {
  ShellItem(this.id, this.cmd);
  final String id, cmd;
  String output = '';
  bool running = true;
  num? code;
}

/// `text`: the resumed session id's first characters.
class NoticeItem extends FeedItem {
  NoticeItem(this.key, this.text);
  final String key, text;
}

const argKeys = [
  'command',
  'file_path',
  'pattern',
  'description',
  'url',
  'query',
  'skill',
  'prompt',
];

String toolArg(Map<String, Object?> input) {
  for (final k in argKeys) {
    final v = input[k];
    if (v != null && v != '' && v != false && v != 0) {
      final line = '$v'.split('\n').first;
      return line.length > 160 ? line.substring(0, 160) : line;
    }
  }
  return '';
}

class Feed {
  List<FeedItem> items = [];
  bool busy = false;
  bool forcePending = false;
  List<String> waiting = [];
  bool agentTurn = false;
  int streamN = 0;
  int lineN = 0;
  int turnSeq = 0;
  bool compacting = false;

  /// archived segments before this conversation's compactions (GET /history pages still to load)
  int earlier = 0;
  String? sessionId, root, title, model;

  String _key() => 'l${lineN++}';

  int _lastOpen() =>
      items.lastIndexWhere((i) => i is AssistantItem && !i.final_);
  int _firstOpen() => items.indexWhere((i) => i is AssistantItem && !i.final_);

  void apply(ServerEvent ev) {
    switch (ev) {
      case ServerEventReplay(:final events, :final earlier):
        final fresh = Feed();
        for (final e in events) {
          fresh.apply(e);
        }
        // the replayed results are history: the live turn count stays
        fresh.turnSeq = turnSeq;
        fresh.earlier = (earlier ?? 0).toInt();
        fresh.sessionId ??= sessionId;
        fresh.root ??= root;
        fresh.title ??= title;
        fresh.model ??= model;
        _take(fresh);
      case ServerEventAgent(:final e):
        _agent(e);
      case ServerEventUser(
        :final id,
        :final text,
        :final force,
        :final historic,
        :final images,
        :final idle,
      ):
        items.add(
          UserItem(
            id,
            text,
            force: force == true,
            idle: idle == true,
            images: images?.length ?? 0,
            duringWork: historic != true && busy,
          ),
        );
        if (historic != true) {
          busy = true;
          waiting = [...waiting, id];
        }
        if (force == true) forcePending = true;
      case ServerEventShellStart(:final id, :final cmd):
        items.removeWhere((i) => i is ShellItem && i.id == id);
        items.add(ShellItem(id, cmd));
      case ServerEventShellOut(:final id, :final text):
        final s = items
            .whereType<ShellItem>()
            .where((i) => i.id == id && i.running)
            .firstOrNull;
        s?.output = text;
      case ServerEventShellEnd(
        :final id,
        :final cmd,
        :final output,
        :final code,
      ):
        // the start may have been archived by a compaction: the end then makes the block itself
        var s = items
            .whereType<ShellItem>()
            .where((i) => i.id == id)
            .firstOrNull;
        if (s == null) {
          s = ShellItem(id, cmd);
          items.add(s);
        }
        s
          ..output = output
          ..running = false
          ..code = code;
      case ServerEventPermission(
        :final id,
        :final toolName,
        :final input,
        :final prompt,
      ):
        items.add(PermissionItem(id, toolName, input, prompt));
      case ServerEventPermissionDone(:final id, :final allow):
        items
                .whereType<PermissionItem>()
                .where((i) => i.id == id)
                .firstOrNull
                ?.answer =
            allow;
      case ServerEventSession(
        :final id,
        :final root,
        :final title,
        :final model,
      ):
        sessionId = id;
        this.root = root;
        this.title = title;
        this.model = model;
      case ServerEventResumed(:final id):
        items.add(NoticeItem(_key(), id.length > 8 ? id.substring(0, 8) : id));
      default:
        break; // not feed items (controls, comments, stats, the one-tab rule, errors)
    }
  }

  String? _idOf(FeedItem i) => switch (i) {
    UserItem(:final id) => 'u:$id',
    AssistantItem(:final id) => 'a:$id',
    ToolItem(:final id) => 't:$id',
    PermissionItem(:final id) => 'p:$id',
    ShellItem(:final id) => 's:$id',
    _ => null,
  };

  /// Puts one `GET /history` page (archived segment [segment]) before the feed. An item already in the feed is not
  /// duplicated; a page for a segment beyond [earlier] (another feed's) changes nothing.
  void prepend(
    List<ServerEvent> events, {
    required int segment,
    required bool more,
  }) {
    if (segment > earlier || earlier == 0) return;
    final page = Feed();
    for (final e in events) {
      page.apply(e);
    }
    final live = {for (final i in items) ?_idOf(i)};
    final head = [
      for (final i in page.items)
        if (!live.contains(_idOf(i)))
          if (i is PermissionItem)
            (i..archived = true)
          else if (i is ShellItem)
            (i..running = false)
          else
            i,
    ];
    items = [...head, ...items];
    earlier = more ? (segment - 1 < 0 ? 0 : segment - 1) : 0;
  }

  void _take(Feed f) {
    items = f.items;
    busy = f.busy;
    forcePending = f.forcePending;
    waiting = f.waiting;
    agentTurn = f.agentTurn;
    streamN = f.streamN;
    lineN = f.lineN;
    turnSeq = f.turnSeq;
    compacting = f.compacting;
    earlier = f.earlier;
    sessionId = f.sessionId;
    root = f.root;
    title = f.title;
    model = f.model;
  }

  void _agent(WireAgentEvent e) {
    switch (e) {
      case WireAgentEventReset():
        // live only: the server's empty replay came first; the session and the live turn count stay
        final keep = Feed()
          ..sessionId = sessionId
          ..root = root
          ..title = title
          ..model = model
          ..turnSeq = turnSeq
          ..lineN = lineN;
        _take(keep);
        items.add(MarkerItem(MarkerKind.cleared, _key()));
      case WireAgentEventCompacting():
        compacting = true;
      case WireAgentEventCompactEnd():
        compacting = false;
      case WireAgentEventCompactFailed(:final error):
        if (!compacting) return;
        compacting = false;
        items.add(MarkerItem(MarkerKind.compactFailed, _key(), error: error));
      case WireAgentEventCompacted(:final preTokens):
        compacting = false;
        items.add(MarkerItem(MarkerKind.compacted, _key(), pre: preTokens));
      case WireAgentEventMessageStart():
        items.add(AssistantItem('stream:${streamN++}', '', final_: false));
      case WireAgentEventMessageChunk(:final text):
        final i = _lastOpen();
        if (i >= 0) (items[i] as AssistantItem).text += text;
      case WireAgentEventMessage(:final id, :final text):
        final item = AssistantItem(id, text, final_: true);
        final i =
            _firstOpen(); // the k-th text block takes the k-th open stream
        if (i >= 0) {
          items[i] = item;
        } else {
          items.add(item);
        }
      case WireAgentEventToolCall(
        :final id,
        :final name,
        :final input,
        :final sub,
      ):
        items.add(ToolItem(id, name, toolArg(input), input, sub: sub));
      case WireAgentEventToolUpdate(:final id, :final text, :final isError):
        final t = items
            .whereType<ToolItem>()
            .where((i) => i.id == id)
            .firstOrNull;
        t
          ?..result = text
          ..isError = isError;
      case WireAgentEventTurnStart():
        busy = true;
        agentTurn = true;
      case WireAgentEventTurnEnd(
        :final stop,
        :final secs,
        :final error,
        :final answers,
        :final queued,
      ):
        // a forced send interrupts the running turn: whatever ends it shows as interrupted, except a real failure
        final status =
            forcePending && !(stop == StopReason.failed && error != null)
            ? StopReason.interrupted
            : stop;
        items = [
          for (final it in items)
            if (it is AssistantItem && !it.final_)
              if (it.text.isNotEmpty) (it..final_ = true) else ...[]
            else
              it,
        ];
        waiting = switch (answers) {
          'all' => [],
          'none' => waiting,
          List l => waiting.where((id) => !l.contains(id)).toList(),
          _ => waiting,
        };
        busy = forcePending || queued > 0 || waiting.isNotEmpty;
        // the live result that follows a clear still arrives: with no user message since the cleared line, no turn
        final cleared = items.lastIndexWhere(
          (i) => i is MarkerItem && i.what == MarkerKind.cleared,
        );
        final orphan =
            cleared >= 0 && !items.skip(cleared).any((i) => i is UserItem);
        if (!orphan) {
          items.add(
            DoneItem(
              _key(),
              secs,
              status,
              error: status == StopReason.failed ? error : null,
            ),
          );
        }
        forcePending = false;
        agentTurn = false;
        turnSeq++;
        compacting = false;
      case WireAgentEventCancelled(:final sendId):
        if (!waiting.contains(sendId)) return;
        waiting = waiting.where((id) => id != sendId).toList();
        busy = forcePending || waiting.isNotEmpty || agentTurn;
      default:
        break; // mode, task, suggestion: not the feed's
    }
  }
}
