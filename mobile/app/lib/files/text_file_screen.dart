// Any project file that is not Markdown, an image or a video, opened over the chat: read through the window's `/file`
// (the first 2 MiB), and shown read-only in the full-screen code view (line numbers, no wrap, pinch zoom, copy,
// comment on a selection anchored to the file). A binary or too large file says so, with its size.
import 'package:flutter/material.dart';

import '../chat/code_screen.dart';
import '../chat/window_tab.dart';
import '../l10n/app_localizations.dart';
import 'remote.dart';

/// highlight.js on a file of 200 kB or more freezes the screen (the desktop's HIGHLIGHT_MAX)
const highlightMax = 200000;

String? _extOf(String path) => RegExp(
  r'\.([a-z0-9]+)$',
  caseSensitive: false,
).firstMatch(path)?[1]?.toLowerCase();

class TextFileScreen extends StatefulWidget {
  const TextFileScreen({super.key, required this.tab, required this.path});
  final WindowTab tab;

  /// relative to the window's root
  final String path;

  @override
  State<TextFileScreen> createState() => _TextFileScreenState();
}

class _TextFileScreenState extends State<TextFileScreen> {
  FileRead? _read;
  FilesError? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _read = null;
      _error = null;
    });
    FileRead? read;
    FilesError? error;
    try {
      read = await readTextFile(widget.tab, widget.path);
    } on FilesError catch (e) {
      error = e;
    } on Object {
      error = FilesError(null);
    }
    if (!mounted) return;
    setState(() {
      _read = read;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final name = widget.path.split('/').last;
    final read = _read;
    if (read is FileText) {
      return CodeScreen(
        code: read.text,
        lang: read.text.length > highlightMax ? null : _extOf(widget.path),
        tab: widget.tab,
        filePath: widget.path,
        title: name,
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(name)),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: switch ((read, _error)) {
            (FileBinary(:final size), _) => Text(
              t.fileBinary(sizeText(size)),
              textAlign: TextAlign.center,
            ),
            (FileTooLarge(:final size), _) => Text(
              t.fileTooLargeSize(sizeText(size)),
              textAlign: TextAlign.center,
            ),
            (_, final FilesError e) => ErrorRetry(
              message: e.outside
                  ? t.fileOutside
                  : e.missing
                  ? t.fileNotFound
                  : t.fileUnreadable,
              onRetry: _load,
            ),
            _ => const CircularProgressIndicator(),
          },
        ),
      ),
    );
  }
}

/// A line that says what failed, with Retry.
class ErrorRetry extends StatelessWidget {
  const ErrorRetry({super.key, required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(message, textAlign: TextAlign.center),
      const SizedBox(height: 8),
      TextButton(
        onPressed: onRetry,
        child: Text(AppLocalizations.of(context).retry),
      ),
    ],
  );
}
