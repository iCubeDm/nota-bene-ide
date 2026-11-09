// A Markdown file of the window, opened over the chat: read through the window's `/file`, drawn as the chat draws
// Markdown, commented by selecting text (the desktop's text anchors on the same rendered text).
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../comments/anchor.dart';
import '../comments/comment_sheet.dart';
import '../l10n/app_localizations.dart';
import 'file_markdown.dart';

/// The largest file the phone opens.
const fileMaxBytes = 2 * 1024 * 1024;

bool isMarkdownPath(String path) =>
    RegExp(r'\.(md|markdown)$', caseSensitive: false).hasMatch(path);

enum _Fail { notMarkdown, notFound, outside, tooLarge, unreadable }

class FileScreen extends StatefulWidget {
  const FileScreen({super.key, required this.tab, required this.path});

  final WindowTab tab;

  /// relative to the window's root
  final String path;

  @override
  State<FileScreen> createState() => _FileScreenState();
}

class _FileScreenState extends State<FileScreen> {
  String? _text;
  RenderedText? _rendered;
  _Fail? _fail;
  final _selection = SelectionListenerNotifier();
  String _selected = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _selection.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (!isMarkdownPath(widget.path))
      return setState(() => _fail = _Fail.notMarkdown);
    final ch = widget.tab.link.channel;
    if (ch == null) return setState(() => _fail = _Fail.unreadable);
    _Fail? fail;
    String? text;
    try {
      final r = await ch.http(
        widget.tab.port,
        'GET',
        '/file?path=${Uri.encodeQueryComponent(widget.path)}',
      );
      if (r.status == 404) {
        fail = _Fail.notFound;
      } else if (r.status == 403) {
        fail = _Fail.outside;
      } else if (r.status != 200) {
        fail = _Fail.unreadable;
      } else if (r.body.length > fileMaxBytes) {
        fail = _Fail.tooLarge;
      } else {
        text = utf8.decode(r.body, allowMalformed: true);
      }
    } on Object {
      fail = _Fail.unreadable;
    }
    if (!mounted) return;
    setState(() {
      _fail = fail;
      _text = text;
      _rendered = text == null ? null : renderedText(parseMarkdown(text));
    });
  }

  List<Mark> _marks() {
    final r = _rendered;
    if (r == null) return const [];
    return [
      for (final c in widget.tab.comments.forFile(widget.path))
        if (resolveAnchor(c.anchor as TextAnchor, r.text) case final at?)
          (
            start: at.start,
            end: at.end,
            id: c.id,
            sent: c.status == CommentStatus.sent,
          ),
    ];
  }

  Future<void> _comment() async {
    final r = _rendered;
    final at = r == null
        ? null
        : locateSelection(
            r,
            _selected,
            _selection.selection.range?.startOffset,
          );
    if (r == null || at == null) return;
    final res = await showCommentSheet(
      context,
      quote: r.text.substring(at.start, at.end),
    );
    if (res is! SheetSave) return;
    widget.tab.comments.add(
      makeAnchor(AnchorSourceFile(path: widget.path), r.text, at.start, at.end),
      res.text,
      res.label,
    );
  }

  Future<void> _edit(String id) async {
    final c = widget.tab.comments.all.where((c) => c.id == id).firstOrNull;
    if (c == null || c.status == CommentStatus.sent)
      return; // a sent comment stays as it went
    final res = await showCommentSheet(
      context,
      quote: (c.anchor as TextAnchor).quote,
      editing: c,
    );
    switch (res) {
      case SheetSave(:final text, :final label):
        widget.tab.comments.edit(id, text, label);
      case SheetDelete():
        widget.tab.comments.remove(id);
      case null:
    }
  }

  String _failText(AppLocalizations t, _Fail f) => switch (f) {
    _Fail.notMarkdown => t.fileNotMarkdown,
    _Fail.notFound => t.fileNotFound,
    _Fail.outside => t.fileOutside,
    _Fail.tooLarge => t.fileTooLarge,
    _Fail.unreadable => t.fileUnreadable,
  };

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final name = widget.path.split('/').last;
    final text = _text, fail = _fail;
    return Scaffold(
      appBar: AppBar(title: Text(name)),
      body: fail != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(_failText(t, fail), textAlign: TextAlign.center),
              ),
            )
          : text == null
          ? const Center(child: CircularProgressIndicator())
          : SelectionArea(
              onSelectionChanged: (s) => _selected = s?.plainText ?? '',
              contextMenuBuilder: (context, state) =>
                  AdaptiveTextSelectionToolbar.buttonItems(
                    anchors: state.contextMenuAnchors,
                    buttonItems: [
                      ContextMenuButtonItem(
                        label: t.comment,
                        onPressed: () {
                          state.hideToolbar();
                          _comment();
                        },
                      ),
                      ...state.contextMenuButtonItems,
                    ],
                  ),
              child: SelectionListener(
                selectionNotifier: _selection,
                child: ListenableBuilder(
                  listenable: widget.tab.comments,
                  builder: (context, _) => ListView(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
                    children: [
                      FileMarkdown(text: text, marks: _marks(), onMark: _edit),
                    ],
                  ),
                ),
              ),
            ),
    );
  }
}
