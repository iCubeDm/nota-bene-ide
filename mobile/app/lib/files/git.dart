// The window's read-only git views as the desktop's panel reads them (server/src/vcs.ts, shared/src/vcs.ts):
// `/git-status` (null outside a repository), `/vcs-diff` (the working tree's changed files), `/vcs-file` (one file's
// patch), `/vcs-log`, `/vcs-commit` and `/vcs-commit-file`, their answers the generated protocol classes. A patch is parsed as
// web/src/vcs/parse.ts does.
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import 'remote.dart';

/// A changed file's status as its letter: A, M, D or R (renamed from [VcsFile.old]); `?` for one a newer host added.
extension VcsFileLetter on VcsFile {
  String get letter => switch (status) {
    VcsFileStatus.a => 'A',
    VcsFileStatus.m => 'M',
    VcsFileStatus.d => 'D',
    VcsFileStatus.r => 'R',
    VcsFileStatus.$unknown => '?',
  };
}

extension VcsCommitShort on VcsCommit {
  String get short => sha.length > 7 ? sha.substring(0, 7) : sha;
}

/// Whether the window's project is in a git repository; null when the host did not say (offline, git timed out).
Future<bool?> isGitRepo(WindowTab tab) async {
  try {
    return await getJson(tab, '/git-status') != null;
  } on FilesError {
    return null;
  }
}

/// The working tree's changes; null outside a repository.
Future<VcsRepoDiff?> fetchChanges(WindowTab tab) async {
  final j = await getJson(tab, '/vcs-diff');
  return switch (VcsDiff.fromJson(j as Map<String, Object?>)) {
    final VcsRepoDiff d => d,
    _ => null,
  };
}

Future<VcsPatch> _patch(WindowTab tab, String path) async {
  final j = await getJson(tab, path);
  return VcsPatch.fromJson(j as Map<String, Object?>);
}

/// One file of the working diff.
Future<VcsPatch> fetchChangePatch(WindowTab tab, VcsFile f) => _patch(
  tab,
  '/vcs-file?${Uri(queryParameters: {'path': f.path, if (f.old != null) 'old': f.old!}).query}',
);

/// The branch's commits (all branches' with [all]); empty outside a repository.
Future<VcsLog> fetchLog(WindowTab tab, {bool all = true}) async {
  final j = await getJson(tab, '/vcs-log?all=${all ? 1 : 0}');
  return VcsLog.fromJson(j as Map<String, Object?>);
}

Future<VcsCommitDetail> fetchCommit(WindowTab tab, String sha) async {
  final j = await getJson(
    tab,
    '/vcs-commit?${Uri(queryParameters: {'sha': sha}).query}',
  );
  return VcsCommitDetail.fromJson(j as Map<String, Object?>);
}

Future<VcsPatch> fetchCommitPatch(
  WindowTab tab,
  String sha,
  VcsFile f,
) => _patch(
  tab,
  '/vcs-commit-file?${Uri(queryParameters: {'sha': sha, 'path': f.path, if (f.old != null) 'old': f.old!}).query}',
);

/// One row of a patch: `t` is ' ', '+' or '-'; [o] and [n] the old and new line numbers.
typedef DiffRow = ({String t, int? o, int? n, String s});
typedef Hunk = ({String head, List<DiffRow> rows});

class ParsedPatch {
  ParsedPatch(this.hunks, this.add, this.del, this.binary);
  final List<Hunk> hunks;
  final int add, del;
  final bool binary;

  int get size => hunks.fold(0, (n, h) => n + h.rows.length);
}

final _hunkHead = RegExp(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@');

/// One file's unified patch into hunks (web/src/vcs/parse.ts). The file's name comes from the list row, never from here.
ParsedPatch parsePatch(String patch) {
  final hunks = <Hunk>[];
  var add = 0, del = 0, binary = false;
  List<DiffRow>? rows;
  var o = 0, n = 0;
  for (final l in patch.split('\n')) {
    if (rows == null && l.startsWith('Binary files')) binary = true;
    final m = _hunkHead.firstMatch(l);
    if (m != null) {
      rows = [];
      hunks.add((head: l, rows: rows));
      o = int.parse(m[1]!);
      n = int.parse(m[2]!);
      continue;
    }
    if (rows == null || l.isEmpty) continue;
    switch (l[0]) {
      case '+':
        rows.add((t: '+', o: null, n: n++, s: l.substring(1)));
        add++;
      case '-':
        rows.add((t: '-', o: o++, n: null, s: l.substring(1)));
        del++;
      case ' ':
        rows.add((t: ' ', o: o++, n: n++, s: l.substring(1)));
    }
  }
  return ParsedPatch(hunks, add, del, binary);
}
