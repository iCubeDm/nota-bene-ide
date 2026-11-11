// The usage statistics of the window's host, as on the desktop's Usage tab (web/src/usage/UsageView.tsx): the same
// requests, the same sections, in one column. Words come from the generated usage strings.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../chat/window_tab.dart';
import '../comments/strings.g.dart';
import '../files/image_screen.dart';
import '../l10n/app_localizations.dart';
import '../ui/insets.dart';
import 'format.dart';

const _pollMs = 2000;
const _agentsShown = 12,
    _modelsShown = 2,
    _rowsShown = 5,
    _weeksShown = 16,
    _windowsShown = 32,
    _tanksShown = 4;

const _periods = [
  (UsagePeriod.trip, 'trip', 'usagePeriodTrip'),
  (UsagePeriod.v7d, '7d', 'usagePeriod7d'),
  (UsagePeriod.v30d, '30d', 'usagePeriod30d'),
  (UsagePeriod.all, 'all', 'usagePeriodAll'),
];
const _providers = [
  (UsageProvider.claude, 'claude', 'Claude'),
  (UsageProvider.codex, 'codex', 'Codex'),
];

/// The desktop's `live()`: a report with calls, or one still being read.
bool _live(UsageReport r) => r.total.calls > 0 || r.importing;

String _lang(BuildContext c) => Localizations.localeOf(c).languageCode;

class UsageScreen extends StatefulWidget {
  const UsageScreen({super.key, required this.tab});
  final WindowTab tab;

  @override
  State<UsageScreen> createState() => _UsageScreenState();
}

class _UsageScreenState extends State<UsageScreen> {
  late UsageProvider _provider =
      widget.tab.capabilities?.provider == CapabilitiesProvider.codex
      ? UsageProvider.codex
      : UsageProvider.claude;
  var _period = UsagePeriod.trip;
  UsageReport? _report;
  String? _error;
  Timer? _timer;
  var _gen = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _gen++;
    _timer?.cancel();
    super.dispose();
  }

  String _name<T>(List<(T, String, String)> l, T v) =>
      l.firstWhere((e) => e.$1 == v).$2;

  /// Asks for the current choice; an answer that is no longer the choice is dropped.
  Future<void> _load() async {
    _timer?.cancel();
    final gen = ++_gen;
    final http = windowHttp(widget.tab);
    try {
      if (http == null) throw 'offline';
      final a = await http(
        'GET',
        '/usage?provider=${_name(_providers, _provider)}&period=${_name(_periods, _period)}',
      );
      if (a.status != 200) throw '${a.status}';
      final data = UsageReport.fromJson(
        (jsonDecode(utf8.decode(a.body)) as Map).cast<String, Object?>(),
      );
      if (!mounted || gen != _gen) return;
      setState(() {
        _report = data;
        _error = null;
      });
      if (data.importing) {
        _timer = Timer(const Duration(milliseconds: _pollMs), _load);
      }
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _error = '$e');
    }
  }

  void _choose({UsageProvider? provider, UsagePeriod? period}) {
    setState(() {
      _provider = provider ?? _provider;
      _period = period ?? _period;
    });
    _load();
  }

  Future<void> _reset() async {
    final lang = _lang(context);
    final t = AppLocalizations.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        content: Text(usageString('usageResetQ', lang)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: Text(t.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: Text(usageString('usageReset', lang)),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final http = windowHttp(widget.tab);
    String? fail;
    try {
      if (http == null) throw 'network';
      final a = await http(
        'POST',
        '/usage/reset',
        headers: {'content-type': 'application/json'},
        body: utf8.encode(
          jsonEncode({'provider': _name(_providers, _provider)}),
        ),
      );
      if (a.status != 200) fail = '${a.status}';
    } catch (_) {
      fail = 'network';
    }
    if (!mounted) return;
    if (fail == null) {
      _choose(period: UsagePeriod.trip);
    } else {
      setState(() => _error = fail);
    }
  }

  @override
  Widget build(BuildContext context) {
    final lang = _lang(context);
    final theme = Theme.of(context);
    final r = _report;
    final shown = r != null && r.provider == _provider && r.period == _period
        ? r
        : null;
    final muted = TextStyle(
      fontSize: 13,
      color: theme.colorScheme.onSurfaceVariant,
    );
    return Scaffold(
      appBar: AppBar(
        title: Text(usageString('usage', lang)),
        actions: [
          IconButton(
            tooltip: usageString('usageReset', lang),
            icon: const Icon(Icons.restart_alt),
            onPressed: _reset,
          ),
        ],
      ),
      body: ListView(
        padding: EdgeInsets.fromLTRB(16, 16, 16, bottomRoom(context)),
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final (p, _, label) in _providers)
                ChoiceChip(
                  label: Text(label),
                  selected: _provider == p,
                  onSelected: (_) => _choose(provider: p),
                ),
            ],
          ),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final (p, _, key) in _periods)
                ChoiceChip(
                  label: Text(usageString(key, lang)),
                  selected: _period == p,
                  onSelected: (_) => _choose(period: p),
                ),
            ],
          ),
          const SizedBox(height: 16),
          if (_error != null)
            Text(
              usageTemplate('usageLoadFail', lang, [_error!]),
              style: TextStyle(color: theme.colorScheme.error, fontSize: 13),
            ),
          if (shown?.importing ?? false)
            Text(
              usageString('usageImporting', lang),
              style: const TextStyle(color: Colors.orange, fontSize: 13),
            ),
          if (shown == null && _error == null)
            Text(usageString('usageLoading', lang), style: muted),
          if (shown != null)
            if (_live(shown))
              _Report(r: shown, lang: lang)
            else
              Text(usageString('usageEmpty', lang), style: muted),
        ],
      ),
    );
  }
}

const _warn = Colors.orange;

Color _rest(BuildContext c) => Theme.of(c).colorScheme.outline;

/// The colour of the model ranked [i] in the report; past the named ones, the rest's.
Color _modelColor(BuildContext c, int? i) {
  final s = Theme.of(c).colorScheme;
  return switch (i) {
    0 => s.primary,
    1 => s.tertiary,
    _ => _rest(c),
  };
}

TextStyle _small(BuildContext c) =>
    TextStyle(fontSize: 12, color: Theme.of(c).colorScheme.onSurfaceVariant);

const _mono = TextStyle(fontFamily: 'monospace', fontSize: 13);

class _Report extends StatelessWidget {
  const _Report({required this.r, required this.lang});
  final UsageReport r;
  final String lang;

  @override
  Widget build(BuildContext context) {
    final rank = {for (final (i, m) in r.models.indexed) m.key: i};
    Color color(String model) => _modelColor(context, rank[model]);
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.end,
          spacing: 8,
          children: [
            Text(
              fmtTokens(r.total.w, lang),
              style: theme.textTheme.displaySmall?.copyWith(
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            Text(usageString('usageTokens', lang)),
            if (r.from != null && r.period == UsagePeriod.trip)
              Text(
                usageTemplate('usageSince', lang, [
                  when(r.from!.toInt(), lang),
                ]),
                style: _small(context),
              ),
          ],
        ),
        const SizedBox(height: 12),
        _ModelMix(r: r, lang: lang),
        const SizedBox(height: 4),
        Text(
          usageTemplate('usageSide', lang, [
            fmtNum(r.total.calls, lang),
            pct(r.total.sub, r.total.w),
          ]),
          style: _small(context),
        ),
        const SizedBox(height: 20),
        _Limits(r: r, lang: lang),
        _Spent(r: r, lang: lang, color: color),
      ],
    );
  }
}

/// A share of the whole, one mark per part, with a gap between them.
class _Mix extends StatelessWidget {
  const _Mix({required this.parts, this.height = 6});
  final List<(num, Color)> parts;
  final double height;

  @override
  Widget build(BuildContext context) {
    final total = parts.fold<num>(0, (a, p) => a + (p.$1 > 0 ? p.$1 : 0));
    return ClipRRect(
      borderRadius: BorderRadius.circular(3),
      child: SizedBox(
        height: height,
        child: Row(
          spacing: 2,
          children: [
            for (final (v, c) in parts)
              Expanded(
                flex: _flex(v, total),
                child: ColoredBox(color: c, child: const SizedBox.expand()),
              ),
          ],
        ),
      ),
    );
  }
}

/// A part's share of [whole] as a flex: the proportion holds at any size, and a tiny part stays visible.
int _flex(num v, num whole) =>
    whole > 0 && v > 0 ? (v / whole * 10000).round().clamp(1, 10000) : 1;

/// A bar's tip: the time, then a line for each figure, as the desktop's.
class _Tip extends StatelessWidget {
  const _Tip({required this.bar, required this.lang});
  final _Bar bar;
  final String lang;

  @override
  Widget build(BuildContext context) {
    final b = bar;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(b.label, style: _small(context)),
        Text(
          '${usageString('usageBarTotal', lang)} ${fmtTokens(b.w, lang)}',
          style: _small(context),
        ),
        if (b.extra > 0 && b.w > b.extra)
          Text(
            '${usageString('usageBarLimit', lang)} ${fmtTokens(b.w - b.extra, lang)}',
            style: _small(context),
          ),
        if (b.extra > 0)
          Text(
            'extra usage ${fmtTokens(b.extra, lang)}',
            style: _small(context),
          ),
        if (b.hit)
          Text(usageString('usageHitShort', lang), style: _small(context)),
      ],
    );
  }
}

class _ModelMix extends StatelessWidget {
  const _ModelMix({required this.r, required this.lang});
  final UsageReport r;
  final String lang;

  @override
  Widget build(BuildContext context) {
    final shown = r.models.take(_modelsShown).toList();
    final rest = r.models.skip(_modelsShown).toList();
    final restW = rest.fold<num>(0, (a, m) => a + m.w);
    final parts = [
      for (final (i, m) in shown.indexed)
        (
          name: modelName(m.key),
          w: m.w,
          color: _modelColor(context, i),
          tip: usageTemplate('usageModelTip', lang, [
            fmtNum(m.calls, lang),
            fmtTokens(m.out, lang),
            fmtTokens(m.write, lang),
            fmtTokens(m.read, lang),
          ]),
        ),
      if (rest.isNotEmpty)
        (
          name: usageString('usageRest', lang),
          w: restW,
          color: _rest(context),
          tip: rest.map((m) => modelName(m.key)).join(', '),
        ),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Mix(parts: [for (final p in parts) (p.w, p.color)], height: 8),
        const SizedBox(height: 8),
        Wrap(
          spacing: 16,
          runSpacing: 4,
          children: [
            for (final p in parts)
              Tooltip(
                message: p.tip,
                triggerMode: TooltipTriggerMode.tap,
                child: Text.rich(
                  TextSpan(
                    style: const TextStyle(fontSize: 13),
                    children: [
                      WidgetSpan(
                        alignment: PlaceholderAlignment.middle,
                        child: Container(
                          width: 8,
                          height: 8,
                          margin: const EdgeInsets.only(right: 6),
                          color: p.color,
                        ),
                      ),
                      TextSpan(
                        text: p.name,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      TextSpan(text: ' ${part(p.w, r.total.w)} '),
                      TextSpan(
                        text: fmtTokens(p.w, lang),
                        style: _small(context),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

typedef _Bar = ({String key, num w, bool hit, num extra, String label});

/// Bars of a series; a tap on one names it above.
class _Bars extends StatefulWidget {
  const _Bars({
    required this.title,
    required this.bars,
    required this.first,
    required this.last,
    required this.lang,
  });
  final String title, first, last, lang;
  final List<_Bar> bars;

  @override
  State<_Bars> createState() => _BarsState();
}

class _BarsState extends State<_Bars> {
  int? _at;

  @override
  Widget build(BuildContext context) {
    final s = Theme.of(context).colorScheme;
    final lang = widget.lang;
    final bars = widget.bars;
    final max = bars.fold<num>(1, (a, b) => b.w > a ? b.w : a);
    final tip = _at == null || _at! >= bars.length ? null : bars[_at!];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(widget.title, style: _small(context)),
        const SizedBox(height: 4),
        if (tip != null) _Tip(bar: tip, lang: lang),
        SizedBox(
          height: 56,
          child: Row(
            spacing: 3,
            children: [
              for (final (i, b) in bars.indexed)
                Expanded(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => setState(() => _at = _at == i ? null : i),
                    child: Align(
                      alignment: Alignment.bottomCenter,
                      child: FractionallySizedBox(
                        heightFactor: (b.w / max).clamp(0.04, 1.0).toDouble(),
                        child: Column(
                          children: [
                            if (b.extra > 0)
                              Expanded(
                                flex: _flex(b.extra, b.w),
                                child: const SizedBox.expand(
                                  child: ColoredBox(color: _warn),
                                ),
                              ),
                            if (b.w > b.extra)
                              Expanded(
                                flex: _flex(b.w - b.extra, b.w),
                                child: SizedBox.expand(
                                  child: ColoredBox(
                                    color: b.hit
                                        ? s.error
                                        : _at == i
                                        ? s.onSurfaceVariant
                                        : s.outlineVariant,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(widget.first, style: _small(context)),
            Text(widget.last, style: _small(context)),
          ],
        ),
      ],
    );
  }
}

class _Limits extends StatefulWidget {
  const _Limits({required this.r, required this.lang});
  final UsageReport r;
  final String lang;

  @override
  State<_Limits> createState() => _LimitsState();
}

class _LimitsState extends State<_Limits> {
  var _all = false;

  @override
  Widget build(BuildContext context) {
    final r = widget.r, lang = widget.lang;
    final windows = r.windows.length > _windowsShown
        ? r.windows.sublist(r.windows.length - _windowsShown)
        : r.windows;
    final weeks = r.weeks.length > _weeksShown
        ? r.weeks.sublist(r.weeks.length - _weeksShown)
        : r.weeks;
    final hits = r.hits.reversed.toList();
    final extra = r.extra;
    if (windows.isEmpty && hits.isEmpty && r.tanks.isEmpty && extra == null) {
      return const SizedBox.shrink();
    }
    final marked = windows.any((w) => w.hit) || weeks.any((w) => w.hit);
    final anyExtra =
        windows.any((w) => (w.extra ?? 0) > 0) ||
        weeks.any((w) => (w.extra ?? 0) > 0);
    final tanks = r.tanks.length > _tanksShown
        ? r.tanks.sublist(r.tanks.length - _tanksShown)
        : r.tanks;
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        spacing: 12,
        children: [
          Text(
            usageString('usageHits', lang),
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          if (marked)
            Text(
              usageString('usageHitMark', lang) +
                  (anyExtra ? ', ${usageString('usageExtraMark', lang)}' : ''),
              style: _small(context),
            ),
          if (windows.isNotEmpty)
            _Bars(
              title: usageString('usageByWindow', lang),
              first: shortTime(windows.first.from.toInt(), lang),
              last: shortTime(windows.last.from.toInt(), lang),
              lang: lang,
              bars: [
                for (final w in windows)
                  (
                    key: '${w.from}',
                    w: w.w,
                    hit: w.hit,
                    extra: w.extra ?? 0,
                    label: when(w.from.toInt(), lang),
                  ),
              ],
            ),
          if (weeks.length > 1)
            _Bars(
              title: usageString('usageByWeek', lang),
              first: weekDay(weeks.first.key, lang),
              last: weekDay(weeks.last.key, lang),
              lang: lang,
              bars: [
                for (final w in weeks)
                  (
                    key: w.key,
                    w: w.w,
                    hit: w.hit,
                    extra: w.extra ?? 0,
                    label:
                        '${weekDay(w.key, lang)} – ${weekDay(w.key, lang, 6)}',
                  ),
              ],
            ),
          if (hits.isNotEmpty) ...[
            for (final h in _all ? hits : hits.take(_rowsShown))
              _HitRow(h: h, currency: extra?.currency, lang: lang),
            if (hits.length > _rowsShown)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: () => setState(() => _all = !_all),
                  child: Text(
                    _all
                        ? usageString('usageShowTop', lang)
                        : usageTemplate('usageShowAll', lang, [hits.length]),
                  ),
                ),
              ),
          ],
          if (extra != null)
            Text(
              [
                usageTemplate('usageExtra', lang, [
                  fmtTokens(extra.w, lang),
                  extra.spent == null
                      ? usageString('usageSumUnknown', lang)
                      : money(extra.spent!, extra.currency, lang),
                ]),
                if (extra.month != null)
                  extra.limit == null
                      ? usageTemplate('usageExtraMonth', lang, [
                          money(extra.month!, extra.currency, lang),
                        ])
                      : usageTemplate('usageExtraOf', lang, [
                          money(extra.month!, extra.currency, lang),
                          money(extra.limit!, extra.currency, lang),
                        ]),
              ].join(' '),
              style: _small(context),
            ),
          if (tanks.isNotEmpty)
            Text(
              '${usageString('usageTank', lang)} ${tanks.map((k) => fmtTokens(k.perPct, lang)).join(' → ')}',
              style: _small(context),
            ),
        ],
      ),
    );
  }
}

class _HitRow extends StatelessWidget {
  const _HitRow({required this.h, required this.currency, required this.lang});
  final UsageHit h;
  final String? currency;
  final String lang;

  @override
  Widget build(BuildContext context) {
    final went =
        (h.projects.entries.toList()
              ..sort((a, b) => b.value.compareTo(a.value)))
            .take(2)
            .map((e) => '${e.key} ${pct(e.value, h.w)}')
            .join(', ');
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(left: 14, bottom: 8),
      dense: true,
      title: Text(
        '${when(h.ts.toInt(), lang)}  ${h.kind == UsageHitKind.week ? usageString('usageWeek', lang) : usageString('usageH5', lang)}',
        style: const TextStyle(fontSize: 13),
      ),
      subtitle: Text(
        '${fmtTokens(h.w, lang)} · ${fmtNum(h.calls, lang)} ${usageString('usageCalls', lang)}${went.isEmpty ? '' : ' · $went'}',
        style: _small(context),
      ),
      children: [
        if (h.extra != null)
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              usageTemplate('usageHitExtra', lang, [
                fmtTokens(h.extra!.w, lang),
                h.extra!.spent == null
                    ? usageString('usageSumUnknown', lang)
                    : money(h.extra!.spent!, currency, lang),
              ]),
              style: _small(context),
            ),
          ),
        for (final k in h.tasks)
          _Line(
            k.label.isEmpty ? usageString('usageNoLabel', lang) : k.label,
            fmtTokens(k.w, lang),
          ),
      ],
    );
  }
}

/// A label that gives way, and its value.
class _Line extends StatelessWidget {
  const _Line(this.label, this.value);
  final String label, value;

  @override
  Widget build(BuildContext context) => Row(
    spacing: 16,
    children: [
      Expanded(
        child: Text(
          label,
          overflow: TextOverflow.ellipsis,
          style: _small(context),
        ),
      ),
      Text(value, style: _mono),
    ],
  );
}

/// A row over a bar of its share of the longest one.
class _ShareRow extends StatelessWidget {
  const _ShareRow({required this.share, required this.child, this.onTap});
  final double share;
  final Widget child;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: Stack(
      children: [
        Positioned.fill(
          child: Align(
            alignment: Alignment.centerLeft,
            child: FractionallySizedBox(
              widthFactor: share.clamp(0.0, 1.0),
              heightFactor: 1,
              child: ColoredBox(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          child: child,
        ),
      ],
    ),
  );
}

class _Spent extends StatefulWidget {
  const _Spent({required this.r, required this.lang, required this.color});
  final UsageReport r;
  final String lang;
  final Color Function(String model) color;

  @override
  State<_Spent> createState() => _SpentState();
}

class _SpentState extends State<_Spent> {
  var _tasks = true;
  String? _open;
  var _all = false;

  @override
  Widget build(BuildContext context) {
    final r = widget.r, lang = widget.lang;
    final items = _tasks ? r.tasks.length : r.projects.length;
    final shown = _all ? items : items.clamp(0, _rowsShown);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              usageString('usageSpent', lang),
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            ChoiceChip(
              label: Text(usageString('usageTasks', lang)),
              selected: _tasks,
              onSelected: (_) => setState(() {
                _tasks = true;
                _all = false;
              }),
            ),
            ChoiceChip(
              label: Text(usageString('usageProjects', lang)),
              selected: !_tasks,
              onSelected: (_) => setState(() {
                _tasks = false;
                _all = false;
              }),
            ),
          ],
        ),
        if (_tasks)
          for (final task in r.tasks.take(shown)) ...[
            _ShareRow(
              share: task.w / r.tasks.first.w,
              onTap: () =>
                  setState(() => _open = _open == task.id ? null : task.id),
              child: Row(
                spacing: 8,
                children: [
                  Expanded(
                    child: Text(
                      task.label.isEmpty
                          ? usageString('usageNoLabel', lang)
                          : task.label,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13),
                    ),
                  ),
                  Flexible(
                    child: Text(
                      task.project,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: _small(context),
                    ),
                  ),
                  Text(fmtTokens(task.w, lang), style: _mono),
                ],
              ),
            ),
            if (_open == task.id)
              _TaskDetail(task: task, lang: lang, color: widget.color),
          ]
        else
          for (final p in r.projects.take(shown))
            _ShareRow(
              share: p.w / r.projects.first.w,
              child: Row(
                spacing: 8,
                children: [
                  Expanded(
                    child: Text(
                      p.key,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13),
                    ),
                  ),
                  Text(part(p.w, r.total.w), style: _small(context)),
                  Text(fmtTokens(p.w, lang), style: _mono),
                ],
              ),
            ),
        if (items > _rowsShown)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => setState(() => _all = !_all),
              child: Text(
                _all
                    ? usageString('usageShowTop', lang)
                    : usageTemplate('usageShowAll', lang, [items]),
              ),
            ),
          ),
      ],
    );
  }
}

class _TaskDetail extends StatelessWidget {
  const _TaskDetail({
    required this.task,
    required this.lang,
    required this.color,
  });
  final UsageTaskRow task;
  final String lang;
  final Color Function(String model) color;

  @override
  Widget build(BuildContext context) {
    final agents = {for (final a in task.agents) a.id: a.label};
    final models = task.models.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    final head = TextStyle(
      fontSize: 13,
      color: Theme.of(context).colorScheme.onSurface,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 8, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        spacing: 8,
        children: [
          Text(
            usageTemplate('usageTaskLine', lang, [
              fmtNum(task.calls, lang),
              pct(task.sub, task.w),
              when(task.ts.toInt(), lang),
            ]),
            style: _small(context),
          ),
          _Mix(parts: [for (final m in models) (m.value, color(m.key))]),
          if (task.agents.isNotEmpty) ...[
            Text(usageString('usageSubagents', lang), style: head),
            for (final a in task.agents.take(_agentsShown))
              _Line(
                a.label.isEmpty ? a.id : a.label,
                '${modelName(a.model)} ${a.calls} ${fmtTokens(a.w, lang)}',
              ),
            if (task.agents.length > _agentsShown)
              Text(
                usageTemplate('usageMoreAgents', lang, [
                  task.agents.length - _agentsShown,
                ]),
                style: _small(context),
              ),
          ],
          Text(usageString('usageTopCalls', lang), style: head),
          for (final c in task.top)
            _Line(
              '${c.agent == null
                  ? usageString('usageMain', lang)
                  : (agents[c.agent] ?? '').isEmpty
                  ? c.agent!
                  : agents[c.agent]!}, '
              '${modelName(c.model)}, ${usageTemplate('usageCallLine', lang, [fmtTokens(c.out, lang), fmtTokens(c.read, lang)])}',
              fmtTokens(c.w, lang),
            ),
        ],
      ),
    );
  }
}
