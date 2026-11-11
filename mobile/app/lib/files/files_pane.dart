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
import '../comments/strings.g.dart';
import '../ui/insets.dart';
import '../ui/folder_tabs.dart';
import 'git.dart';
import 'git_pages.dart';
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
    this.observers = const [],
  });
  final WindowTab tab;

  /// The pane's own navigator, for a host that wants Android's back to go up a folder first.
  final GlobalKey<NavigatorState>? navigatorKey;

  /// Watching the pane's navigator (how deep it is).
  final List<NavigatorObserver> observers;

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
    // the room under a floating header is the pane's, not its pages': every page of the navigator, a folder or a
    // commit, starts below it, and it follows a rotation
    final navigator = Navigator(
      key: widget.navigatorKey,
      observers: widget.observers,
      onGenerateRoute: (_) =>
          MaterialPageRoute<void>(builder: (_) => _PaneHome(tab: widget.tab)),
    );
    return Padding(
      padding: EdgeInsets.only(top: widget.topInset),
      child: widget.topInset > 0
          ? MediaQuery.removePadding(
              context: context,
              removeTop: true,
              child: navigator,
            )
          : navigator,
    );
  }
}

/// The pane's first page: tabs like Telegram's folders (Files, Changes, Log; the last two only in a git repository)
/// over the project tree, the working tree's changes and the log. A folder or a commit opens as a page over it.
class _PaneHome extends StatefulWidget {
  const _PaneHome({required this.tab});
  final WindowTab tab;

  @override
  State<_PaneHome> createState() => _PaneHomeState();
}

class _PaneHomeState extends State<_PaneHome> {
  int _at = 0;
  bool? _repo;
  bool _asking = false;

  @override
  void initState() {
    super.initState();
    widget.tab.addListener(_maybeAsk);
    _maybeAsk();
  }

  @override
  void dispose() {
    widget.tab.removeListener(_maybeAsk);
    super.dispose();
  }

  /// Asked once the window is open, and again later when the host could not say.
  Future<void> _maybeAsk() async {
    if (_repo != null || _asking || widget.tab.state != TabState.open) return;
    _asking = true;
    final repo = await isGitRepo(widget.tab);
    _asking = false;
    if (!mounted) return;
    if (repo != null) setState(() => _repo = repo);
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    final repo = _repo == true;
    final at = repo ? _at : 0;
    return Scaffold(
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: Column(
        children: [
          if (repo)
            SizedBox(
              height: 40,
              child: FolderTabs(
                labels: [t.tabFiles, webString('vcsChanges', lang), t.tabLog],
                at: at.toDouble(),
                onTap: (i) => setState(() => _at = i),
              ),
            ),
          Expanded(
            child: IndexedStack(
              index: at,
              children: [
                FolderPage(tab: widget.tab, dir: ''),
                if (repo) ChangesPage(tab: widget.tab),
                if (repo) LogPage(tab: widget.tab),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// `…ends/of/a/long/path`, cut from the left so the end (the folder itself) stays.
String pathTail(String path, [int max = 34]) =>
    path.length <= max ? path : '…${path.substring(path.length - max + 1)}';

class FolderPage extends StatefulWidget {
  const FolderPage({super.key, required this.tab, required this.dir});
  final WindowTab tab;

  /// relative to the project root; '' is the root
  final String dir;

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
      builder: (_) => FolderPage(tab: widget.tab, dir: path),
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

  /// The files the agent touched; it follows the feed while the page is open.
  Widget _session(AppLocalizations t, NbColors c) => ListenableBuilder(
    listenable: widget.tab,
    builder: (context, _) {
      final session = sessionFiles(widget.tab);
      if (session.isEmpty) return const SizedBox.shrink();
      final shown = _allSession
          ? session
          : session.take(sessionFilesShown).toList();
      final label = TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w600,
        color: c.mutedFg,
      );
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
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
      );
    },
  );

  /// The listing, built as it scrolls: the session on top (at the root), a note while there are no entries, then
  /// the entries.
  Widget _listing(AppLocalizations t, NbColors c) {
    final error = _error, entries = _entries;
    final head = _root ? 1 : 0;
    final Widget? note = error != null
        ? Padding(
            padding: const EdgeInsets.all(24),
            child: ErrorRetry(message: _failText(t, error), onRetry: _load),
          )
        : entries == null
        ? const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator()),
          )
        : entries.isEmpty
        ? Padding(
            padding: const EdgeInsets.all(24),
            child: Center(child: Text(t.emptyFolder)),
          )
        : null;
    final rows = error != null ? const <TreeEntry>[] : entries ?? const [];
    final lead = head + (note == null ? 0 : 1);
    return ListView.builder(
      padding: EdgeInsets.only(bottom: bottomRoom(context)),
      itemCount: lead + rows.length,
      itemBuilder: (context, i) {
        if (i < head) return _session(t, c);
        if (note != null && i == head) return note;
        final e = rows[i - lead];
        return _row(
          c,
          icon: e.dir ? Icons.folder_outlined : fileIcon(e.name),
          title: e.name,
          folder: e.dir,
          onTap: () => e.dir
              ? _openFolder(_join(e.name))
              : openFile(context, widget.tab, _join(e.name)),
        );
      },
    );
  }

  Widget _results(AppLocalizations t, NbColors c) {
    final hits = _hits!;
    final Widget? note = _searchError != null
        ? Padding(
            padding: const EdgeInsets.all(24),
            child: ErrorRetry(
              message: t.fileUnreadable,
              onRetry: () => _search(_query.text.trim()),
            ),
          )
        : hits.isEmpty
        ? Padding(
            padding: const EdgeInsets.all(24),
            child: Center(child: Text(t.noMatches)),
          )
        : null;
    return ListView.builder(
      padding: EdgeInsets.only(bottom: bottomRoom(context)),
      itemCount: note == null ? hits.length : 1,
      itemBuilder: (context, i) {
        if (note != null) return note;
        final h = hits[i];
        final p = h.endsWith('/') ? h.substring(0, h.length - 1) : h;
        return _row(
          c,
          icon: h.endsWith('/') ? Icons.folder_outlined : fileIcon(h),
          title: p.split('/').last,
          subtitle: p.contains('/') ? p.substring(0, p.lastIndexOf('/')) : null,
          folder: h.endsWith('/'),
          onTap: () => _openHit(h),
        );
      },
    );
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
      body: Column(
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
          Expanded(child: _hits != null ? _results(t, c) : _listing(t, c)),
        ],
      ),
    );
  }
}
