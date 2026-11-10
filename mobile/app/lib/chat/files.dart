// Where files open from in the chat: a tool line on a file of the project the phone opens (Markdown, an image, a
// video), and the agent menu's Files (the session's such files, from its tool calls). The file opens over the chat;
// back returns to it.
import 'package:flutter/material.dart';

import '../files/file_screen.dart';
import '../files/image_screen.dart';
import '../files/text_file_screen.dart';
import '../files/video_screen.dart';
import 'feed.dart';
import 'window_tab.dart';

enum FileKind { markdown, image, video }

final _image = RegExp(r'\.(png|jpe?g|gif|webp|bmp)$', caseSensitive: false);
final _video = RegExp(r'\.(mp4|mov|webm|m4v)$', caseSensitive: false);

/// What the phone opens [path] as, or null when it does not open it.
FileKind? fileKindOf(String path) => isMarkdownPath(path)
    ? FileKind.markdown
    : _image.hasMatch(path)
    ? FileKind.image
    : _video.hasMatch(path)
    ? FileKind.video
    : null;

IconData fileIcon(String path) => switch (fileKindOf(path)) {
  FileKind.image => Icons.image_outlined,
  FileKind.video => Icons.movie_outlined,
  FileKind.markdown => Icons.article_outlined,
  _ => _code.hasMatch(path) ? Icons.code : Icons.description_outlined,
};

final _code = RegExp(
  r'\.(dart|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|sql|html|css|scss|vue|svelte|json|ya?ml|toml|xml|gradle|lua|r)$',
  caseSensitive: false,
);

/// A name with an extension: what a tool call's path argument looks like when it is a file and not a folder.
bool looksLikeFile(String path) =>
    RegExp(r'[^/.][^/]*\.[A-Za-z0-9]+$').hasMatch(path);

/// [path] relative to [root] when it is a file inside the project that the phone opens, else null.
String? projectFile(String root, String path) {
  final rel = projectPath(root, path);
  return rel == null || fileKindOf(rel) == null ? null : rel;
}

/// [path] relative to [root] when it names a file of the project, whatever its kind (the file browser opens it as text
/// when it is none of Markdown, image or video), else null.
String? projectPath(String root, String path) {
  final r = root.endsWith('/') ? root.substring(0, root.length - 1) : root;
  var rel = path.startsWith('/')
      ? (path.startsWith('$r/') ? path.substring(r.length + 1) : null)
      : path;
  // the desktop's anchor path has no `./`
  while (rel != null && rel.startsWith('./')) {
    rel = rel.substring(2);
  }
  if (rel == null ||
      rel.isEmpty ||
      rel.split('/').contains('..') ||
      !looksLikeFile(rel)) {
    return null;
  }
  return rel;
}

/// The path a tool call works on, as the agents name it.
String? toolPath(ToolItem it) => switch (it.input['file_path'] ??
    it.input['path'] ??
    it.input['notebook_path']) {
  final String p => p,
  _ => null,
};

/// The session's files the phone opens, newest first, each once.
List<String> sessionFiles(WindowTab tab) {
  final seen = <String>{};
  return [
    for (final it in tab.feed.items.reversed.whereType<ToolItem>())
      if (toolPath(it) case final p?)
        if (projectPath(tab.root, p) case final rel? when seen.add(rel)) rel,
  ];
}

/// Opens [rel] full screen over everything (also from inside a pane's own navigator): Markdown, an image or a video as
/// they are, any other file as read-only text.
void openFile(BuildContext context, WindowTab tab, String rel, {double? at}) =>
    Navigator.of(context, rootNavigator: true).push(
      MaterialPageRoute<void>(
        builder: (_) => switch (fileKindOf(rel)) {
          FileKind.image => ImageScreen(tab: tab, path: rel),
          FileKind.video => VideoScreen(tab: tab, path: rel, at: at),
          FileKind.markdown => FileScreen(tab: tab, path: rel),
          null => TextFileScreen(tab: tab, path: rel),
        },
      ),
    );

/// Gives the feed's tool lines their window, so a file line can open its file.
class FileOpener extends InheritedWidget {
  const FileOpener({super.key, required this.tab, required super.child});
  final WindowTab tab;

  static WindowTab? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<FileOpener>()?.tab;

  @override
  bool updateShouldNotify(FileOpener old) => old.tab != tab;
}
