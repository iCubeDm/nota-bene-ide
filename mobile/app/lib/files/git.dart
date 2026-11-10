// The window's read-only git views as the desktop's panel reads them (server/src/vcs.ts, shared/src/vcs.ts):
// `/git-status` (null outside a repository), `/vcs-diff` (the working tree's changed files), `/vcs-file` (one file's
// patch), `/vcs-log`, `/vcs-commit` and `/vcs-commit-file`. A patch is parsed as web/src/vcs/parse.ts does.
import '../chat/window_tab.dart';
import 'remote.dart';

/// One changed file of a diff or a commit: [status] is A, M, D or R (renamed from [old]).
class GitFile {
  const GitFile({
    required this.path,
    this.old,
    required this.status,
    this.add,
    this.del,
    required this.binary,
  });
  final String path, status;
  final String? old;
  final int? add, del;
  final bool binary;

  factory GitFile.fromJson(Map<String, Object?> j) => GitFile(
    path: j['path']! as String,
    old: j['old'] as String?,
    status: j['status']! as String,
    add: (j['add'] as num?)?.toInt(),
    del: (j['del'] as num?)?.toInt(),
    binary: j['binary'] == true,
  );
}

List<GitFile> _files(Object? j) => [
  for (final f in (j as List? ?? const []))
    if (f is Map) GitFile.fromJson(f.cast<String, Object?>()),
];

/// The working tree's changes: the branch it is on, what it is compared to and the files.
class Changes {
  const Changes({
    required this.branch,
    required this.base,
    required this.uncommitted,
    required this.files,
    required this.truncated,
  });
  final String? branch, base;
  final bool uncommitted, truncated;
  final List<GitFile> files;
}

class GitCommit {
  const GitCommit({
    required this.sha,
    required this.author,
    required this.at,
    required this.subject,
    required this.refs,
  });
  final String sha, author, subject;
  final int at;
  final List<String> refs;
  String get short => sha.length > 7 ? sha.substring(0, 7) : sha;
}

class CommitDetail {
  const CommitDetail({
    required this.sha,
    required this.author,
    required this.at,
    required this.message,
    required this.files,
    required this.truncated,
  });
  final String sha, author, message;
  final int at;
  final List<GitFile> files;
  final bool truncated;
}

class Patch {
  const Patch(this.text, this.truncated);
  final String text;
  final bool truncated;
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
Future<Changes?> fetchChanges(WindowTab tab) async {
  final j = await getJson(tab, '/vcs-diff');
  if (j is! Map || j['repo'] != true) return null;
  return Changes(
    branch: j['branch'] as String?,
    base: j['base'] as String?,
    uncommitted: j['uncommitted'] == true,
    files: _files(j['files']),
    truncated: j['truncated'] == true,
  );
}

Future<Patch> _patch(WindowTab tab, String path) async {
  final j = await getJson(tab, path);
  if (j is! Map) throw FilesError(null);
  return Patch((j['patch'] as String?) ?? '', j['truncated'] == true);
}

/// One file of the working diff.
Future<Patch> fetchChangePatch(WindowTab tab, GitFile f) => _patch(
  tab,
  '/vcs-file?${Uri(queryParameters: {'path': f.path, if (f.old != null) 'old': f.old!}).query}',
);

/// The branch's commits (all branches' with [all]); empty outside a repository.
Future<({List<GitCommit> commits, bool more})> fetchLog(
  WindowTab tab, {
  bool all = true,
}) async {
  final j = await getJson(tab, '/vcs-log?all=${all ? 1 : 0}');
  if (j is! Map) throw FilesError(null);
  return (
    commits: [
      for (final c in (j['commits'] as List? ?? const []))
        if (c is Map)
          GitCommit(
            sha: c['sha']! as String,
            author: (c['author'] as String?) ?? '',
            at: (c['at'] as num?)?.toInt() ?? 0,
            subject: (c['subject'] as String?) ?? '',
            refs: [
              for (final r in (c['refs'] as List? ?? const []))
                if (r is String) r,
            ],
          ),
    ],
    more: j['more'] == true,
  );
}

Future<CommitDetail> fetchCommit(WindowTab tab, String sha) async {
  final j = await getJson(
    tab,
    '/vcs-commit?${Uri(queryParameters: {'sha': sha}).query}',
  );
  if (j is! Map) throw FilesError(null);
  return CommitDetail(
    sha: j['sha']! as String,
    author: (j['author'] as String?) ?? '',
    at: (j['at'] as num?)?.toInt() ?? 0,
    message: (j['message'] as String?) ?? '',
    files: _files(j['files']),
    truncated: j['truncated'] == true,
  );
}

Future<Patch> fetchCommitPatch(WindowTab tab, String sha, GitFile f) => _patch(
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
