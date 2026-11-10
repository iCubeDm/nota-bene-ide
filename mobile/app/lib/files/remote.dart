// The window's file routes the file browser reads: `GET /tree?path=<dir>` (JSON `[{name, dir}]`), `GET /complete?q=`
// (up to 30 project-relative paths, folders ending in `/`) and `GET /file?path=` (raw bytes, Range supported). All
// through the window's encrypted channel.
import 'dart:convert';

import '../chat/window_tab.dart';
import 'file_screen.dart' show fileMaxBytes;

/// Why a route did not answer: [status] is the HTTP status, null when the host could not be reached.
class FilesError implements Exception {
  FilesError(this.status);
  final int? status;
  bool get outside => status == 403;
  bool get missing => status == 404;
  @override
  String toString() => 'FilesError($status)';
}

class TreeEntry {
  const TreeEntry(this.name, this.dir);
  final String name;
  final bool dir;
}

/// Folders first, then files, each by name without regard to case.
List<TreeEntry> sortEntries(Iterable<TreeEntry> entries) =>
    entries.toList()..sort((a, b) {
      if (a.dir != b.dir) return a.dir ? -1 : 1;
      final c = a.name.toLowerCase().compareTo(b.name.toLowerCase());
      return c != 0 ? c : a.name.compareTo(b.name);
    });

Future<dynamic> _json(WindowTab tab, String path) async {
  final ch = tab.link.channel;
  if (ch == null) throw FilesError(null);
  final r = await ch
      .http(tab.port, 'GET', path)
      .catchError((Object _) => throw FilesError(null));
  if (r.status != 200) throw FilesError(r.status);
  try {
    return jsonDecode(utf8.decode(r.body));
  } on FormatException {
    throw FilesError(null);
  }
}

/// The entries of project folder [dir] (relative; '' is the root).
Future<List<TreeEntry>> fetchTree(WindowTab tab, String dir) async {
  final j = await _json(tab, '/tree?path=${Uri.encodeQueryComponent(dir)}');
  if (j is! List) throw FilesError(null);
  return sortEntries([
    for (final e in j)
      if (e is Map && e['name'] is String)
        TreeEntry(e['name'] as String, e['dir'] == true),
  ]);
}

/// The host's fuzzy search: paths relative to the project, a folder with a trailing `/`.
Future<List<String>> completeFiles(WindowTab tab, String q) async {
  final j = await _json(tab, '/complete?q=${Uri.encodeQueryComponent(q)}');
  if (j is! List) throw FilesError(null);
  return [
    for (final p in j)
      if (p is String) p,
  ];
}

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

/// Reads [path] (relative to the project) for the code view. Asks for the first [fileMaxBytes] + 1 bytes with a Range
/// request: a file over the cap is told by its total size and not downloaded.
Future<FileRead> readTextFile(WindowTab tab, String path) async {
  final ch = tab.link.channel;
  if (ch == null) throw FilesError(null);
  final r = await ch
      .http(
        tab.port,
        'GET',
        '/file?path=${Uri.encodeQueryComponent(path)}',
        headers: {'range': 'bytes=0-$fileMaxBytes'},
      )
      .catchError((Object _) => throw FilesError(null));
  if (r.status != 200 && r.status != 206) throw FilesError(r.status);
  var size = r.body.length;
  final range = RegExp(r'/(\d+)$').firstMatch(r.headers['content-range'] ?? '');
  if (range != null) size = int.parse(range[1]!);
  if (size > fileMaxBytes || r.body.length > fileMaxBytes) {
    return FileTooLarge(size);
  }
  final head = r.body.length > _probe ? r.body.sublist(0, _probe) : r.body;
  if (head.contains(0)) return FileBinary(size);
  final text = utf8.decode(r.body, allowMalformed: true);
  // a few replacement characters are a stray byte; many are a binary file
  final bad = '�'.allMatches(text).length;
  if (bad > 8 && bad * 100 > text.length) return FileBinary(size);
  return FileText(text);
}

/// A size for a person: `812 B`, `3.4 KB`, `12 MB`.
String sizeText(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}
