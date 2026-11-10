// The project's files as a pane: "This session" (the files the agent touched) on top of the root listing, folders
// first and then files by name, a folder opening as a page of the pane's own navigator (back goes up), a search field
// that asks the host's fuzzy search. A file opens full screen over everything (`openFile`); back returns here, to the
// same folder and place. The pane works as a full page or beside the chat: it needs only its window, and keeps its own
// navigation, so a host screen decides where to put it.
import 'dart:async';

import 'package:flutter/material.dart';

import '../chat/files.dart';
import '../chat/window_tab.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'remote.dart';
import 'text_file_screen.dart' show ErrorRetry;

/// How many of the session's files show before "Show all".
const sessionFilesShown = 5;

/// How long typing pauses before the search asks the host.
const searchDebounce = Duration(milliseconds: 250);

class FilesPane extends StatefulWidget {
  const FilesPane({
    super.key,
    required this.tab,
    this.navigatorKey,
    this.topInset = 0,
  });
  final WindowTab tab;

  /// The pane's own navigator, for a host that wants Android's back to go up a folder first.
  final GlobalKey<NavigatorState>? navigatorKey;

  /// Room kept clear at the top (a floating header over the pane).
  final double topInset;

  @override
  State<FilesPane> createState() => _FilesPaneState();
}

class _FilesPaneState extends State<FilesPane>
    with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Navigator(
      key: widget.navigatorKey,
      onGenerateRoute: (_) => MaterialPageRoute<void>(
        builder: (_) =>
            FolderPage(tab: widget.tab, dir: '', topInset: widget.topInset),
      ),
    );
  }
}

/// `…ends/of/a/long/path`, cut from the left so the end (the folder itself) stays.
String pathTail(String path, [int max = 34]) =>
    path.length <= max ? path : '…${path.substring(path.length - max + 1)}';

class FolderPage extends StatefulWidget {
  const FolderPage({
    super.key,
    required this.tab,
    required this.dir,
    this.topInset = 0,
  });
  final WindowTab tab;

  /// relative to the project root; '' is the root
  final String dir;
  final double topInset;

  @override
  State<FolderPage> createState() => _FolderPageState();
}

class _FolderPageState extends State<FolderPage> {
  List<TreeEntry>? _entries;
  FilesError? _error;
  bool _allSession = false;

  final _query = TextEditingController();
  Timer? _debounce;
  // the hits of the current query; null while the field is empty
  List<String>? _hits;
  FilesError? _searchError;
  int _asked = 0;

  bool get _root => widget.dir.isEmpty;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _query.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _entries = null;
      _error = null;
    });
    List<TreeEntry>? entries;
    FilesError? error;
    try {
      entries = await fetchTree(widget.tab, widget.dir);
    } on FilesError catch (e) {
      error = e;
    } on Object {
      error = FilesError(null);
    }
    if (!mounted) return;
    setState(() {
      _entries = entries;
      _error = error;
    });
  }

  void _typed(String q) {
    _debounce?.cancel();
    setState(() {});
    if (q.trim().isEmpty) {
      _asked++;
      setState(() {
        _hits = null;
        _searchError = null;
      });
      return;
    }
    _debounce = Timer(searchDebounce, () => _search(q.trim()));
  }

  Future<void> _search(String q) async {
    final mine = ++_asked;
    List<String>? hits;
    FilesError? error;
    try {
      hits = await completeFiles(widget.tab, q);
    } on FilesError catch (e) {
      error = e;
    } on Object {
      error = FilesError(null);
    }
    if (!mounted || mine != _asked) return;
    setState(() {
      _hits = hits ?? const [];
      _searchError = error;
    });
  }

  String _join(String name) => _root ? name : '${widget.dir}/$name';

  void _openFolder(String path) => Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) =>
          FolderPage(tab: widget.tab, dir: path, topInset: widget.topInset),
    ),
  );

  void _openHit(String hit) {
    if (hit.endsWith('/')) {
      _openFolder(hit.substring(0, hit.length - 1));
    } else {
      openFile(context, widget.tab, hit);
    }
  }

  String _failText(AppLocalizations t, FilesError e) => e.outside
      ? t.fileOutside
      : e.missing
      ? t.folderNotFound
      : t.fileUnreadable;

  Widget _row(
    NbColors c, {
    required IconData icon,
    required String title,
    String? subtitle,
    required VoidCallback onTap,
    bool folder = false,
  }) => ListTile(
    dense: true,
    visualDensity: VisualDensity.compact,
    leading: Icon(icon, color: folder ? c.accent : c.mutedFg),
    title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
    subtitle: subtitle == null
        ? null
        : Text(
            subtitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: c.mutedFg, fontSize: 12),
          ),
    onTap: onTap,
  );

  List<Widget> _listing(AppLocalizations t, NbColors c) {
    final error = _error, entries = _entries;
    final session = _root ? sessionFiles(widget.tab) : const <String>[];
    final shown = _allSession
        ? session
        : session.take(sessionFilesShown).toList();
    final label = TextStyle(
      fontSize: 12,
      fontWeight: FontWeight.w600,
      color: c.mutedFg,
    );
    return [
      if (session.isNotEmpty) ...[
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
          child: Text(t.thisSession, style: label),
        ),
        for (final f in shown)
          _row(
            c,
            icon: fileIcon(f),
            title: f.split('/').last,
            subtitle: f.contains('/')
                ? f.substring(0, f.lastIndexOf('/'))
                : null,
            onTap: () => openFile(context, widget.tab, f),
          ),
        if (session.length > shown.length)
          TextButton(
            onPressed: () => setState(() => _allSession = true),
            child: Text(t.showAll('${session.length}')),
          ),
        const Divider(height: 16),
      ],
      if (error != null)
        Padding(
          padding: const EdgeInsets.all(24),
          child: ErrorRetry(message: _failText(t, error), onRetry: _load),
        )
      else if (entries == null)
        const Padding(
          padding: EdgeInsets.all(24),
          child: Center(child: CircularProgressIndicator()),
        )
      else ...[
        if (entries.isEmpty)
          Padding(
            padding: const EdgeInsets.all(24),
            child: Center(child: Text(t.emptyFolder)),
          ),
        for (final e in entries)
          _row(
            c,
            icon: e.dir ? Icons.folder_outlined : fileIcon(e.name),
            title: e.name,
            folder: e.dir,
            onTap: () => e.dir
                ? _openFolder(_join(e.name))
                : openFile(context, widget.tab, _join(e.name)),
          ),
      ],
    ];
  }

  List<Widget> _results(AppLocalizations t, NbColors c) {
    final hits = _hits!;
    if (_searchError != null) {
      return [
        Padding(
          padding: const EdgeInsets.all(24),
          child: ErrorRetry(
            message: t.fileUnreadable,
            onRetry: () => _search(_query.text.trim()),
          ),
        ),
      ];
    }
    if (hits.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.all(24),
          child: Center(child: Text(t.noMatches)),
        ),
      ];
    }
    return [
      for (final h in hits)
        _row(
          c,
          icon: h.endsWith('/') ? Icons.folder_outlined : fileIcon(h),
          title: (h.endsWith('/') ? h.substring(0, h.length - 1) : h)
              .split('/')
              .last,
          subtitle: () {
            final p = h.endsWith('/') ? h.substring(0, h.length - 1) : h;
            return p.contains('/') ? p.substring(0, p.lastIndexOf('/')) : null;
          }(),
          folder: h.endsWith('/'),
          onTap: () => _openHit(h),
        ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final title = _root
        ? (widget.tab.root.split('/').where((s) => s.isNotEmpty).lastOrNull ??
              t.projectFolder)
        : widget.dir;
    return Scaffold(
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: Padding(
        padding: EdgeInsets.only(top: widget.topInset),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                if (!_root)
                  IconButton(
                    tooltip: t.folderUp,
                    icon: const Icon(Icons.arrow_back),
                    onPressed: () => Navigator.of(context).maybePop(),
                  )
                else
                  const SizedBox(width: 16),
                Expanded(
                  child: Text(
                    pathTail(title),
                    key: const ValueKey('folder-path'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: c.foreground,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
              ],
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
              child: TextField(
                controller: _query,
                onChanged: _typed,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  isDense: true,
                  hintText: t.searchFiles,
                  prefixIcon: const Icon(Icons.search, size: 20),
                  suffixIcon: _query.text.isEmpty
                      ? null
                      : IconButton(
                          icon: const Icon(Icons.close, size: 18),
                          onPressed: () {
                            _query.clear();
                            _typed('');
                          },
                        ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(22),
                  ),
                ),
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.only(bottom: 16),
                children: _hits != null ? _results(t, c) : _listing(t, c),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
