// What the git views show of the window's answers ([Repository] reads them): a file's letter, a commit's short sha, and
// a patch parsed as web/src/vcs/parse.ts does.
import 'package:nb_protocol/nb_protocol.dart';

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
