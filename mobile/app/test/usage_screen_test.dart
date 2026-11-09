import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_app/usage/format.dart';
import 'package:nb_app/usage/usage_screen.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/fakes.dart';
import 'support/rig.dart';

String w(String key) => usageString(key, 'en');

Map<String, Object?> row(num calls, num wt, {num sub = 0}) => {
  'calls': calls,
  'w': wt,
  'sub': sub,
  'in': 1,
  'out': 2,
  'write': 3,
  'read': 4,
};

/// A report for [provider] and [period]; [total] tokens, [importing] while the host still reads transcripts.
Map<String, Object?> report({
  String provider = 'claude',
  String period = 'trip',
  num total = 1500000,
  bool importing = false,
  int calls = 12,
}) => {
  'provider': provider,
  'period': period,
  'from': 1700000000000,
  'importing': importing,
  'total': row(calls, total, sub: total / 4),
  'models': [
    {'key': 'claude-opus-5-5', ...row(8, total * 0.6)},
    {'key': 'claude-sonnet-5-5', ...row(4, total * 0.3)},
    {'key': 'claude-haiku-5-5', ...row(2, total * 0.1)},
  ],
  'projects': [
    {'key': 'notes', ...row(12, total)},
  ],
  'tasks': [
    {
      'id': 't1',
      'ts': 1700000000000,
      'label': 'Write the intro',
      'project': 'notes',
      'models': {'claude-opus-5-5': 900000},
      'agents': [
        {
          'id': 'a1',
          'label': 'Researcher',
          'model': 'claude-sonnet-5-5',
          'calls': 3,
          'w': 5000,
        },
      ],
      'top': [
        {
          'ts': 1700000000000,
          'model': 'claude-opus-5-5',
          'w': 7000,
          'in': 1,
          'out': 2,
          'write': 3,
          'read': 4,
        },
      ],
      ...row(5, 900000),
    },
  ],
  'hits': [
    {
      'ts': 1700000000000,
      'kind': '5h',
      'calls': 2,
      'w': 1000,
      'projects': {'notes': 1000},
      'models': {'claude-opus-5-5': 1000},
      'tasks': <Object?>[],
    },
  ],
  'weeks': [
    {'key': '2023-11-06', 'w': 1000, 'hit': true},
    {'key': '2023-11-13', 'w': 800, 'hit': false},
  ],
  'windows': [
    {'from': 1700000000000, 'w': 1000, 'hit': true},
  ],
  'tanks': [
    {'from': 1, 'to': 2, 'pct': 10, 'w': 100, 'perPct': 10},
  ],
};

void main() {
  late Rig r;
  Future<HttpAnswer> Function(String path)? on;
  var post = 200;
  setUp(() async {
    on = null;
    post = 200;
    await initializeDateFormatting();
    r = Rig();
  });
  tearDown(() => r.dispose());

  /// Answers `/usage` with [f]; a POST to `/usage/reset` with [reset]. Installed once the window is open.
  void host(Future<HttpAnswer> Function(String path) f, {int reset = 200}) {
    on = f;
    post = reset;
  }

  void install() {
    r.ch.onHttp = (port, method, path) async {
      if (method == 'POST' && path == '/usage/reset') {
        return answer(post, '{}');
      }
      return on!(path);
    };
  }

  Future<void> show(WidgetTester t, {String? provider}) async {
    await r.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': Rig.caps(provider: provider),
      },
    );
    install();
    unawaited(
      Navigator.of(
        t.element(find.byType(Scaffold).first),
      ).push(MaterialPageRoute<void>(builder: (_) => UsageScreen(tab: r.tab!))),
    );
    await t.pumpAndSettle();
  }

  List<String> usageGets() => [
    for (final q in r.ch.requests)
      if (q.startsWith('GET /usage?')) q,
  ];

  testWidgets('opens on the window\'s provider and trip, with the total', (
    t,
  ) async {
    host((p) async => answer(200, jsonEncode(report())));
    await show(t);
    expect(usageGets(), ['GET /usage?provider=claude&period=trip']);
    expect(find.text('1.5M'), findsOneWidget);
    expect(find.text(w('usageTokens')), findsOneWidget);
    expect(find.textContaining('Opus 5.5'), findsWidgets);
  });

  testWidgets('a codex window opens on codex', (t) async {
    host((p) async => answer(200, jsonEncode(report(provider: 'codex'))));
    await show(t, provider: 'codex');
    expect(usageGets(), ['GET /usage?provider=codex&period=trip']);
  });

  testWidgets('a late answer for the old period is not shown', (t) async {
    final slow = Completer<HttpAnswer>();
    host(
      (p) => p.contains('period=7d')
          ? Future.value(
              answer(200, jsonEncode(report(period: '7d', total: 2000000))),
            )
          : p.contains('period=30d')
          ? slow.future
          : Future.value(answer(200, jsonEncode(report()))),
    );
    await show(t);
    await t.tapText(w('usagePeriod30d'));
    await t.tapText(w('usagePeriod7d'));
    expect(find.text('2.0M'), findsOneWidget);
    slow.complete(
      answer(200, jsonEncode(report(period: '30d', total: 9000000))),
    );
    await t.pumpAndSettle();
    expect(find.text('9.0M'), findsNothing);
    expect(find.text('2.0M'), findsOneWidget);
  });

  testWidgets('a report of another provider is never shown', (t) async {
    host((p) async => answer(200, jsonEncode(report(provider: 'codex'))));
    await show(t);
    expect(find.text('1.5M'), findsNothing);
    expect(find.text(w('usageLoading')), findsOneWidget);
  });

  testWidgets('a failing request says so and does not spin', (t) async {
    host((p) async => answer(500, '{}'));
    await show(t);
    expect(
      find.text(usageTemplate('usageLoadFail', 'en', ['500'])),
      findsOneWidget,
    );
    expect(find.text(w('usageLoading')), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('importing polls every 2 s until the screen is left', (t) async {
    host((p) async => answer(200, jsonEncode(report(importing: true))));
    await show(t);
    expect(find.text(w('usageImporting')), findsOneWidget);
    expect(usageGets(), hasLength(1));
    await t.pump(const Duration(seconds: 2, milliseconds: 100));
    expect(usageGets(), hasLength(2));
    Navigator.of(t.element(find.byType(UsageScreen))).pop();
    await t.pumpAndSettle();
    await t.pump(const Duration(seconds: 6));
    expect(usageGets(), hasLength(2));
  });

  testWidgets('reset asks, posts the provider, and reloads on trip', (t) async {
    host(
      (p) async => answer(
        200,
        jsonEncode(report(period: p.contains('period=all') ? 'all' : 'trip')),
      ),
    );
    await show(t);
    await t.tapText(w('usagePeriodAll'));
    await t.tap(find.byTooltip(w('usageReset')));
    await t.pumpAndSettle();
    expect(find.text(w('usageResetQ')), findsOneWidget);
    expect(r.ch.calls.where((c) => c.method == 'POST'), isEmpty);
    await t.tap(find.widgetWithText(FilledButton, w('usageReset')));
    await t.pumpAndSettle();
    final post = r.ch.calls.singleWhere((c) => c.method == 'POST');
    expect(post.path, '/usage/reset');
    expect(jsonDecode(utf8.decode(post.body)), {'provider': 'claude'});
    expect(usageGets().last, 'GET /usage?provider=claude&period=trip');
  });

  testWidgets('a refused reset says so', (t) async {
    host((p) async => answer(200, jsonEncode(report())), reset: 409);
    await show(t);
    await t.tap(find.byTooltip(w('usageReset')));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(FilledButton, w('usageReset')));
    await t.pumpAndSettle();
    expect(
      find.text(usageTemplate('usageLoadFail', 'en', ['409'])),
      findsOneWidget,
    );
  });

  testWidgets('a task row opens its detail', (t) async {
    host((p) async => answer(200, jsonEncode(report())));
    await show(t);
    await t.scrollUntilVisible(find.text('Write the intro'), 300);
    await t.drag(find.byType(ListView), const Offset(0, -200));
    await t.pumpAndSettle();
    expect(find.text(w('usageTopCalls')), findsNothing);
    await t.tap(find.text('Write the intro'));
    await t.pumpAndSettle();
    expect(find.text(w('usageTopCalls')), findsOneWidget);
    expect(find.text(w('usageSubagents')), findsWidgets);
  });

  testWidgets('the model mix keeps its proportions at billions of tokens', (
    t,
  ) async {
    final rep = report(total: 4.7e9);
    rep['models'] = [
      {'key': 'claude-opus-5-5', ...row(8, 3.2e9)},
      {'key': 'claude-sonnet-5-5', ...row(4, 1.5e9)},
    ];
    host((p) async => answer(200, jsonEncode(rep)));
    await show(t);
    final parts = find.descendant(
      of: find.byType(ClipRRect),
      matching: find.byType(ColoredBox),
    );
    final a = t.getSize(parts.at(0)).width, b = t.getSize(parts.at(1)).width;
    expect(a / (a + b), closeTo(0.68, 0.02));
  });

  testWidgets('a bar\'s tip names every line and does not overflow', (t) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(400, 900);
    t.platformDispatcher.textScaleFactorTestValue = 1.5;
    addTearDown(t.view.reset);
    addTearDown(t.platformDispatcher.clearAllTestValues);
    final rep = report();
    rep['windows'] = [
      {'from': 1700000000000, 'w': 5000, 'hit': true, 'extra': 2000},
    ];
    host((p) async => answer(200, jsonEncode(rep)));
    await show(t);
    final bar = find
        .byWidgetPredicate((x) => x is SizedBox && x.height == 56)
        .first;
    await t.ensureVisible(bar);
    await t.pumpAndSettle();
    await t.tap(bar);
    await t.pumpAndSettle();
    for (final line in [
      when(1700000000000, 'en'),
      '${w('usageBarTotal')} ${fmtTokens(5000, 'en')}',
      '${w('usageBarLimit')} ${fmtTokens(3000, 'en')}',
      'extra usage ${fmtTokens(2000, 'en')}',
      w('usageHitShort'),
    ]) {
      expect(find.text(line), findsOneWidget, reason: line);
    }
    expect(t.takeException(), isNull);
  });

  testWidgets('a long project and task name do not overflow a task row', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(320, 900);
    addTearDown(t.view.reset);
    final rep = report();
    final task = ((rep['tasks'] as List).first as Map).cast<String, Object?>();
    task['label'] = 'L' * 120;
    task['project'] = 'P' * 120;
    host((p) async => answer(200, jsonEncode(rep)));
    await show(t);
    await t.scrollUntilVisible(find.text(fmtTokens(900000, 'en')), 300);
    expect(t.takeException(), isNull);
    expect(find.text(fmtTokens(900000, 'en')), findsOneWidget);
  });

  testWidgets('the agent menu opens the screen', (t) async {
    await r.open(t);
    host((p) async => answer(200, jsonEncode(report())));
    install();
    await t.tap(find.byTooltip('Agent'));
    await t.pumpAndSettle();
    await t.tapText(w('usage'));
    expect(find.byType(UsageScreen), findsOneWidget);
    expect(usageGets(), hasLength(1));
  });

  testWidgets('the menu item is disabled without the usage capability', (
    t,
  ) async {
    await r.open(
      t,
      hello: {
        'kind': 'hello',
        'protocol': 13,
        'capabilities': Rig.caps(usage: false),
      },
    );
    await t.tap(find.byTooltip('Agent'));
    await t.pumpAndSettle();
    expect(
      t
          .widget<PopupMenuItem<Object?>>(
            find.widgetWithText(PopupMenuItem<Object?>, w('usage')),
          )
          .enabled,
      isFalse,
    );
  });
}
