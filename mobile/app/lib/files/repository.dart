// The window's data over its connection (issue 547), as the web's `web/src/sdk/repository.ts`: one load path for the
// routes the screens read, `GET /tree?path=<dir>` (a list of `TreeEntry`), `/complete?q=` (`CompleteAnswer`: up to 30
// project-relative paths, folders ending in `/`), `/file?path=` (raw bytes, Range supported) and git's read-only views
// as the desktop's panel reads them (server/src/vcs.ts, shared/src/vcs.ts): `/git-status` (null outside a repository),
// `/vcs-diff`, `/vcs-file`, `/vcs-log`, `/vcs-commit` and `/vcs-commit-file`, the host's `/usage` and the window's
// `/dictation`, their answers the generated protocol classes where there are any. Requests for the same route in flight share one answer, and none goes while the host is offline. Nothing
// is kept once answered (the web keeps the last answer for its watchers; the phone has none, its screens hold what
// they show).
import 'dart:convert';

import 'package:nb_channel/nb_channel.dart' show HttpAnswer;
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/agent_connection.dart';

/// The largest file the phone opens.
const fileMaxBytes = 2000000;

/// Why a route did not answer: [status] is the HTTP status, null when the host could not be reached; [cause] what
/// broke, when the request or its answer failed rather than the host being offline.
class FilesError implements Exception {
  FilesError(this.status, [this.cause]);
  final int? status;
  final Object? cause;
  bool get outside => status == 403;
  bool get missing => status == 404;
  @override
  String toString() => 'FilesError($status)';
}

/// Folders first, then files, each by name without regard to case.
List<TreeEntry> sortEntries(Iterable<TreeEntry> entries) =>
    entries.toList()..sort((a, b) {
      if (a.dir != b.dir) return a.dir ? -1 : 1;
      final c = a.name.toLowerCase().compareTo(b.name.toLowerCase());
      return c != 0 ? c : a.name.compareTo(b.name);
    });

/// What reading a file gave.
sealed class FileRead {}

class FileText extends FileRead {
  FileText(this.text);
  final String text;
}

/// Not text (a NUL byte, or bytes that are not UTF-8), [size] in bytes.
class FileBinary extends FileRead {
  FileBinary(this.size);
  final int size;
}

class FileTooLarge extends FileRead {
  FileTooLarge(this.size);
  final int size;
}

/// The part of the bytes looked at for a NUL.
const _probe = 8000;

class Repository {
  Repository(this._conn);

  final AgentConnection _conn;
  final _inFlight = <String, Future<HttpAnswer>>{};

  /// Counts the writes begun and ended: a read never joins one asked for across a write.
  var _writes = 0;

  /// `GET` [route] of the window; [FilesError] (no status) when the host is offline or the stream broke. A request
  /// for the same route and headers on the same channel while one is on its way gets that one's answer.
  Future<HttpAnswer> get(String route, {Map<String, String>? headers}) {
    final http = _conn.http;
    if (http == null) return Future.error(FilesError(null));
    // by channel too: after a reconnect a request does not wait on one still out on the dead channel
    final key =
        '${identityHashCode(_conn.link.channel)} $_writes $route${headers == null ? '' : ' $headers'}';
    return _inFlight[key] ??= http('GET', route, headers: headers)
        .catchError((Object e) => throw FilesError(null, e))
        .whenComplete(() {
          _inFlight.remove(
            key,
          ); // a block: a returned future would be awaited, and this one is its own
        });
  }

  /// A write to the window ([method] is not `GET`); [FilesError] (no status) when the host is offline or the stream
  /// broke. A read asked for during or after it does not join one asked for before it.
  Future<HttpAnswer> write(
    String method,
    String route, {
    Map<String, String>? headers,
    List<int>? body,
  }) {
    final http = _conn.http;
    if (http == null) return Future.error(FilesError(null));
    _writes++;
    return http(method, route, headers: headers, body: body)
        .catchError((Object e) => throw FilesError(null, e))
        .whenComplete(() => _writes++);
  }

  /// The JSON answer of [route]; [FilesError] when it did not answer 200.
  Future<dynamic> _json(String route) async {
    final r = await get(route);
    if (r.status != 200) throw FilesError(r.status);
    try {
      return jsonDecode(utf8.decode(r.body));
    } on FormatException catch (e) {
      throw FilesError(null, e);
    }
  }

  /// The entries of project folder [dir] (relative; '' is the root).
  Future<List<TreeEntry>> tree(String dir) async {
    final j = await _json('/tree?path=${Uri.encodeQueryComponent(dir)}');
    return sortEntries([
      for (final e in j as List) TreeEntry.fromJson(e as Map<String, Object?>),
    ]);
  }

  /// The host's fuzzy search: paths relative to the project, a folder with a trailing `/`.
  Future<CompleteAnswer> complete(String q) async {
    final j = await _json('/complete?q=${Uri.encodeQueryComponent(q)}');
    return List<String>.from(j as List);
  }

  /// Reads [path] (relative to the project) for the code view. Asks for the first [fileMaxBytes] + 1 bytes with a
  /// Range request: a file over the cap is told by its total size and not downloaded.
  Future<FileRead> readText(String path) async {
    final r = await get(
      '/file?path=${Uri.encodeQueryComponent(path)}',
      headers: {'range': 'bytes=0-$fileMaxBytes'},
    );
    // a Range request for a 0-byte file is unsatisfiable (416, `bytes */0`): the file is empty
    if (r.status == 416 && (r.headers['content-range'] ?? '').endsWith('/0')) {
      return FileText('');
    }
    if (r.status != 200 && r.status != 206) throw FilesError(r.status);
    var size = r.body.length;
    final range = RegExp(
      r'/(\d+)$',
    ).firstMatch(r.headers['content-range'] ?? '');
    if (range != null) size = int.parse(range[1]!);
    if (size > fileMaxBytes || r.body.length > fileMaxBytes) {
      return FileTooLarge(size);
    }
    final head = r.body.length > _probe ? r.body.sublist(0, _probe) : r.body;
    if (head.contains(0)) return FileBinary(size);
    final text = utf8.decode(r.body, allowMalformed: true);
    // a few replacement characters are a stray byte; many are a binary file
    final bad = '\uFFFD'.allMatches(text).length;
    if (bad > 8 && bad * 100 > text.length) return FileBinary(size);
    return FileText(text);
  }

  /// The host's usage report, as the desktop's Usage tab reads it.
  Future<UsageReport> usage(
    UsageProvider provider,
    UsagePeriod period,
  ) async => UsageReport.fromJson(
    (await _json(
              '/usage?provider=${provider.toJson()}&period=${period.toJson()}',
            )
            as Map)
        .cast<String, Object?>(),
  );

  /// The window's Whisper as Settings → Dictation shows it (`on`, `phase`, the sizes); null when it did not answer.
  Future<Map<Object?, Object?>?> dictation() async {
    try {
      final j = await _json('/dictation');
      return j is Map ? j : const {};
    } on FilesError {
      return null;
    }
  }

  /// Whether the window's project is in a git repository; null when the host did not say (offline, git timed out).
  Future<bool?> isGitRepo() async {
    try {
      return await _json('/git-status') != null;
    } on FilesError {
      return null;
    }
  }

  /// The working tree's changes; null outside a repository.
  Future<VcsRepoDiff?> changes() async {
    final j = await _json('/vcs-diff');
    return switch (VcsDiff.fromJson(j as Map<String, Object?>)) {
      final VcsRepoDiff d => d,
      _ => null,
    };
  }

  Future<VcsPatch> _patch(String route) async =>
      VcsPatch.fromJson(await _json(route) as Map<String, Object?>);

  /// One file of the working diff.
  Future<VcsPatch> changePatch(VcsFile f) => _patch(
    '/vcs-file?${Uri(queryParameters: {'path': f.path, if (f.old != null) 'old': f.old!}).query}',
  );

  /// The branch's commits (all branches' with [all]); empty outside a repository.
  Future<VcsLog> log({bool all = true}) async => VcsLog.fromJson(
    await _json('/vcs-log?all=${all ? 1 : 0}') as Map<String, Object?>,
  );

  Future<VcsCommitDetail> commit(String sha) async => VcsCommitDetail.fromJson(
    await _json('/vcs-commit?${Uri(queryParameters: {'sha': sha}).query}')
        as Map<String, Object?>,
  );

  Future<VcsPatch> commitPatch(String sha, VcsFile f) => _patch(
    '/vcs-commit-file?${Uri(queryParameters: {'sha': sha, 'path': f.path, if (f.old != null) 'old': f.old!}).query}',
  );
}
