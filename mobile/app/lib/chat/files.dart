// Where files open from in the chat: a tool line on a Markdown file of the project, and the agent menu's Files (the
// session's Markdown files, from its tool calls). The file opens over the chat; back returns to it.
import 'package:flutter/material.dart';

import '../files/file_screen.dart';
import '../l10n/app_localizations.dart';
import 'feed.dart';
import 'window_tab.dart';

/// [path] relative to [root] when it is a Markdown file inside the project, else null.
String? projectMarkdown(String root, String path) {
  final r = root.endsWith('/') ? root.substring(0, root.length - 1) : root;
  final rel = path.startsWith('/')
      ? (path.startsWith('$r/') ? path.substring(r.length + 1) : null)
      : path;
  if (rel == null ||
      rel.isEmpty ||
      rel.split('/').contains('..') ||
      !isMarkdownPath(rel)) {
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

/// The session's Markdown files, newest first, each once.
List<String> sessionFiles(WindowTab tab) {
  final seen = <String>{};
  return [
    for (final it in tab.feed.items.reversed.whereType<ToolItem>())
      if (toolPath(it) case final p?)
        if (projectMarkdown(tab.root, p) case final rel? when seen.add(rel))
          rel,
  ];
}

void openFile(BuildContext context, WindowTab tab, String rel) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => FileScreen(tab: tab, path: rel),
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

Future<void> showFiles(BuildContext context, WindowTab tab) =>
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (c) {
        final t = AppLocalizations.of(c);
        final files = sessionFiles(tab);
        if (files.isEmpty) {
          return Padding(
            padding: const EdgeInsets.all(24),
            child: Text(t.noFiles),
          );
        }
        return ListView(
          shrinkWrap: true,
          children: [
            for (final f in files)
              ListTile(
                leading: const Icon(Icons.description_outlined),
                title: Text(f),
                onTap: () {
                  Navigator.pop(c);
                  openFile(context, tab, f);
                },
              ),
          ],
        );
      },
    );
