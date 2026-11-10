// The Files pane's Changes and Log tabs: the working tree's changed files, and the branch's commits with each
// commit's files. A file opens its diff full screen (`DiffScreen`).
import 'package:flutter/material.dart';

import '../chat/window_tab.dart';
import '../comments/strings.g.dart';
import '../l10n/app_localizations.dart';
import '../theme.dart';
import 'diff_screen.dart';
import 'git.dart';
import 'remote.dart';
import 'text_file_screen.dart' show ErrorRetry;

Color statusColor(NbColors c, String status) => switch (status) {
  'A' => c.success,
  'D' => c.destructive,
  'R' => c.link,
  _ => c.accent,
};

void openDiff(
  BuildContext context,
  WindowTab tab,
  GitFile file,
  Future<Patch> Function() load, {
  String? ref,
}) => Navigator.of(context, rootNavigator: true).push(
  MaterialPageRoute<void>(
    builder: (_) => DiffScreen(tab: tab, file: file, load: load, ref: ref),
  ),
);

/// A file row: its status letter, name over folder, and the lines added and removed.
class GitFileRow extends StatelessWidget {
  const GitFileRow({super.key, required this.file, required this.onTap});
  final GitFile file;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).extension<NbColors>()!;
    final i = file.path.lastIndexOf('/');
    final name = file.path.substring(i + 1);
    final dir = i < 0 ? null : file.path.substring(0, i);
    return ListTile(
      dense: true,
      visualDensity: VisualDensity.compact,
      leading: SizedBox(
        width: 16,
        child: Text(
          file.status,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontFamily: 'monospace',
            fontWeight: FontWeight.w700,
            color: statusColor(c, file.status),
          ),
        ),
      ),
      title: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: dir == null
          ? null
          : Text(
              dir,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: c.mutedFg, fontSize: 12),
            ),
      trailing: file.binary
          ? null
          : Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: '+${file.add ?? 0} ',
                    style: TextStyle(color: c.success),
                  ),
                  TextSpan(
                    text: '−${file.del ?? 0}',
                    style: TextStyle(color: c.destructive),
                  ),
                ],
              ),
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
            ),
      onTap: onTap,
    );
  }
}

String failText(AppLocalizations t, FilesError e) => e.outside
    ? t.fileOutside
    : e.missing
    ? t.fileNotFound
    : t.fileUnreadable;

class ChangesPage extends StatefulWidget {
  const ChangesPage({super.key, required this.tab});
  final WindowTab tab;

  @override
  State<ChangesPage> createState() => _ChangesPageState();
}

class _ChangesPageState extends State<ChangesPage> {
  Changes? _changes;
  bool _loaded = false;
  FilesError? _error;
  int _turn = -1;

  @override
  void initState() {
    super.initState();
    _turn = widget.tab.feed.turnSeq;
    widget.tab.addListener(_tabChanged);
    _load();
  }

  @override
  void dispose() {
    widget.tab.removeListener(_tabChanged);
    super.dispose();
  }

  /// A turn ended: the agent may have changed files.
  void _tabChanged() {
    if (widget.tab.feed.turnSeq != _turn) {
      _turn = widget.tab.feed.turnSeq;
      _load(quiet: true);
    }
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet) setState(() => _error = null);
    Changes? changes;
    FilesError? error;
    try {
      changes = await fetchChanges(widget.tab);
    } on FilesError catch (e) {
      error = e;
    } on Object {
      error = FilesError(null);
    }
    if (!mounted) return;
    setState(() {
      _loaded = true;
      // a failed refresh keeps what was shown
      if (error == null) _changes = changes;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final ch = _changes;
    Widget body;
    if (!_loaded) {
      body = const Center(child: CircularProgressIndicator());
    } else if (_error != null && ch == null) {
      body = Center(
        child: ErrorRetry(message: failText(t, _error!), onRetry: _load),
      );
    } else if (ch == null) {
      body = Center(child: Text(webString('vcsNoRepo', lang)));
    } else {
      final name = ch.branch ?? 'HEAD';
      final head = ch.uncommitted
          ? batchTemplate('vcsOnlyUncommitted', lang, [name])
          : ch.base == null
          ? name
          : '$name ${batchTemplate('vcsAgainst', lang, [ch.base!])}';
      final lead = <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Text(head, style: TextStyle(color: c.mutedFg, fontSize: 12)),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              webString('vcsFailed', lang),
              style: TextStyle(color: c.accent, fontSize: 12),
            ),
          ),
        if (ch.files.isEmpty)
          Padding(
            padding: const EdgeInsets.all(24),
            child: Center(child: Text(webString('vcsNoChanges', lang))),
          ),
      ];
      // the files are built as they scroll
      body = ListView.builder(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 16),
        itemCount: lead.length + ch.files.length,
        itemBuilder: (context, i) {
          if (i < lead.length) return lead[i];
          final f = ch.files[i - lead.length];
          return GitFileRow(
            file: f,
            onTap: () => openDiff(
              context,
              widget.tab,
              f,
              () => fetchChangePatch(widget.tab, f),
            ),
          );
        },
      );
    }
    return RefreshIndicator(onRefresh: () => _load(quiet: true), child: body);
  }
}

String when(BuildContext context, int seconds) {
  final d = DateTime.fromMillisecondsSinceEpoch(seconds * 1000);
  return '${MaterialLocalizations.of(context).formatShortDate(d)} '
      '${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(d), alwaysUse24HourFormat: true)}';
}

class LogPage extends StatefulWidget {
  const LogPage({super.key, required this.tab});
  final WindowTab tab;

  @override
  State<LogPage> createState() => _LogPageState();
}

class _LogPageState extends State<LogPage> {
  List<GitCommit>? _commits;
  bool _more = false;
  FilesError? _error;
  int _turn = -1;

  @override
  void initState() {
    super.initState();
    _turn = widget.tab.feed.turnSeq;
    widget.tab.addListener(_tabChanged);
    _load();
  }

  @override
  void dispose() {
    widget.tab.removeListener(_tabChanged);
    super.dispose();
  }

  void _tabChanged() {
    if (widget.tab.feed.turnSeq != _turn) {
      _turn = widget.tab.feed.turnSeq;
      _load();
    }
  }

  Future<void> _load() async {
    List<GitCommit>? commits;
    bool more = false;
    FilesError? error;
    try {
      final r = await fetchLog(widget.tab);
      commits = r.commits;
      more = r.more;
    } on FilesError catch (e) {
      error = e;
    } on Object {
      error = FilesError(null);
    }
    if (!mounted) return;
    setState(() {
      if (error == null) {
        _commits = commits;
        _more = more;
      }
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final lang = Localizations.localeOf(context).languageCode;
    final commits = _commits;
    Widget body;
    if (_error != null && commits == null) {
      body = Center(
        child: ErrorRetry(message: failText(t, _error!), onRetry: _load),
      );
    } else if (commits == null) {
      body = const Center(child: CircularProgressIndicator());
    } else if (commits.isEmpty) {
      body = Center(child: Text(webString('vcsNoCommits', lang)));
    } else {
      final lead = _error == null ? 0 : 1;
      // the commits are built as they scroll
      body = ListView.builder(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 16),
        itemCount: lead + commits.length + (_more ? 1 : 0),
        itemBuilder: (context, i) {
          if (i < lead) {
            return Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Text(
                webString('vcsFailed', lang),
                style: TextStyle(color: c.accent, fontSize: 12),
              ),
            );
          }
          if (i - lead >= commits.length) {
            return Padding(
              padding: const EdgeInsets.all(12),
              child: Center(
                child: Text(
                  batchTemplate('vcsLogCut', lang, [commits.length]),
                  style: TextStyle(color: c.mutedFg, fontSize: 12),
                ),
              ),
            );
          }
          final k = commits[i - lead];
          return ListTile(
            dense: true,
            title: Text(
              k.subject,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(
              [
                k.short,
                k.author,
                when(context, k.at),
                for (final r in k.refs)
                  if (!r.endsWith('/HEAD'))
                    r.replaceFirst('HEAD -> ', '').replaceFirst('tag: ', ''),
              ].join(' · '),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: c.mutedFg, fontSize: 12),
            ),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => CommitPage(tab: widget.tab, commit: k),
              ),
            ),
          );
        },
      );
    }
    return RefreshIndicator(onRefresh: _load, child: body);
  }
}

/// A commit: its message and its files; a file opens its diff.
class CommitPage extends StatefulWidget {
  const CommitPage({super.key, required this.tab, required this.commit});
  final WindowTab tab;
  final GitCommit commit;

  @override
  State<CommitPage> createState() => _CommitPageState();
}

class _CommitPageState extends State<CommitPage> {
  CommitDetail? _detail;
  FilesError? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    CommitDetail? detail;
    FilesError? error;
    try {
      detail = await fetchCommit(widget.tab, widget.commit.sha);
    } on FilesError catch (e) {
      error = e;
    } on Object {
      error = FilesError(null);
    }
    if (!mounted) return;
    setState(() {
      _detail = detail;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    final c = Theme.of(context).extension<NbColors>()!;
    final d = _detail;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.commit.short,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 16),
        ),
      ),
      body: _error != null
          ? Center(
              child: ErrorRetry(message: failText(t, _error!), onRetry: _load),
            )
          : d == null
          ? const Center(child: CircularProgressIndicator())
          : ListView.builder(
              padding: const EdgeInsets.only(bottom: 16),
              itemCount: 3 + d.files.length,
              itemBuilder: (context, i) {
                if (i == 0) {
                  return Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                    child: Text(
                      d.message,
                      style: const TextStyle(fontSize: 14),
                    ),
                  );
                }
                if (i == 1) {
                  return Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    child: Text(
                      '${d.sha.substring(0, 7)} · ${d.author} · ${when(context, d.at)}',
                      style: TextStyle(color: c.mutedFg, fontSize: 12),
                    ),
                  );
                }
                if (i == 2) return const Divider(height: 1);
                final f = d.files[i - 3];
                return GitFileRow(
                  file: f,
                  onTap: () => openDiff(
                    context,
                    widget.tab,
                    f,
                    () => fetchCommitPatch(widget.tab, d.sha, f),
                    ref: d.sha.substring(0, 7),
                  ),
                );
              },
            ),
    );
  }
}
