// What a full-screen code view (a file, a diff) needs to tie its rows to the desktop's anchors: which characters the
// existing comments cover, and where the selection starts. Both work over the code's rendered text (whitespace as one
// space), and the single text node of its `pre` maps the code's characters to it.
import 'package:flutter/rendering.dart' show SelectionStatus;
import 'package:flutter/widgets.dart';
import 'package:nb_protocol/nb_protocol.dart'
    show Comment, CommentStatus, TextAnchor;

import '../comments/anchor.dart';
import 'code.dart' show CodeMark;

/// The ranges of the code's characters that [comments] cover in [r] (the rendered text of that code): each comment
/// resolved by its anchor, an overlapping one skipped (the first paints).
List<CodeMark> codeMarksFor(RenderedText r, Iterable<Comment> comments) {
  if (r.runs.isEmpty) return const [];
  final run = r.runs.first;
  final found = <({int from, int to, String id, bool sent})>[];
  for (final c in comments) {
    final a = c.anchor;
    if (a is! TextAnchor) continue;
    final at = resolveAnchor(a, r.text);
    if (at == null) continue;
    int? from, to;
    for (var i = 0; i < run.raw.length; i++) {
      final here = run.map[i];
      // a collapsed space emits nothing
      if (run.map[i + 1] <= here) continue;
      if (here >= at.start && here < at.end) {
        from ??= i;
        to = i + 1;
      }
    }
    if (from != null) {
      found.add((
        from: from,
        to: to!,
        id: c.id,
        sent: c.status == CommentStatus.sent,
      ));
    }
  }
  found.sort((a, b) => a.from.compareTo(b.from));
  final out = <CodeMark>[];
  var end = 0;
  for (final f in found) {
    if (f.from < end) continue;
    out.add((start: f.from, end: f.to, id: f.id, sent: f.sent, n: 0));
    end = f.to;
  }
  return out;
}

/// The part of [marks] that falls in the row of [length] characters starting at [from], as the row's own offsets.
List<CodeMark> marksInRow(List<CodeMark> marks, int from, int length) => [
  for (final m in marks)
    if (m.start < from + length && m.end > from)
      (
        start: m.start > from ? m.start - from : 0,
        end: m.end - from < length ? m.end - from : length,
        id: m.id,
        sent: m.sent,
        n: 0,
      ),
];

/// Where the selection starts in [r], by the rows' selection listeners: the first row that holds it, the offset in it
/// added to the row's start ([startOf]) in the code's characters and mapped to the rendered text. Null when none does.
int? selectionHint(
  RenderedText r,
  Map<int, SelectionListenerNotifier> listeners,
  int Function(int row) startOf,
  int rows,
) {
  final run = r.runs.firstOrNull;
  if (run == null) return null;
  for (final i in listeners.keys.toList()..sort()) {
    final l = listeners[i]!;
    if (!l.registered || i >= rows) continue;
    final range = l.selection.range;
    if (range == null || l.selection.status == SelectionStatus.none) continue;
    final raw = (startOf(i) + range.startOffset).clamp(0, run.map.length - 1);
    return run.map[raw];
  }
  return null;
}
