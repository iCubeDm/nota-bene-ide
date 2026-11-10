import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_header.dart';
import 'package:nb_app/chat/one_tab.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';

Map<String, Object?> tool(String id, String name) => agent({
  't': 'tool-call',
  'id': id,
  'name': name,
  'input': {'command': 'x'},
  'sub': false,
});

Map<String, Object?> user(String id) => {
  'kind': 'user',
  'id': id,
  'text': 'go',
  'ts': 1,
};

Map<String, Object?> turnEnd() => agent({
  't': 'turn-end',
  'stop': 'done',
  'secs': 3,
  'answers': 'all',
  'queued': 0,
});

/// An event arrives a microtask after the pump that follows it; the second pump draws it.
Future<void> flush(WidgetTester t) async {
  await t.pump();
  await t.pump();
}

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  Finder line() => find.byKey(const ValueKey('state-line'));
  String lineText(WidgetTester t) => t.widget<Text>(line()).data!;
  Color lineColor(WidgetTester t) => t.widget<Text>(line()).style!.color!;
  NbColors colors(WidgetTester t) =>
      Theme.of(t.element(find.byType(ChatHeader))).extension<NbColors>()!;

  testWidgets('idle without a known end: just online', (t) async {
    await r.open(t);
    expect(lineText(t), 'online');
    expect(lineColor(t), colors(t).mutedFg);
  });

  testWidgets('idle after a turn: online, done at the time it ended', (
    t,
  ) async {
    await r.open(t);
    r.tab!.clock = () => DateTime(2026, 5, 1, 12, 4);
    r.event(user('u1'));
    r.event(turnEnd());
    await flush(t);
    expect(lineText(t), 'online · done 12:04');
    expect(lineColor(t), colors(t).mutedFg);
    expect(find.byKey(const ValueKey('busy-dot')), findsNothing);
  });

  testWidgets('working: the phase of the current tool and the elapsed time', (
    t,
  ) async {
    await r.open(t);
    var now = DateTime(2026, 5, 1, 12);
    r.tab!.clock = () => now;
    r.event(user('u1'));
    r.event(tool('t1', 'Read'));
    await flush(t);
    now = now.add(const Duration(seconds: 125));
    await t.pump(const Duration(seconds: 1));
    expect(lineText(t), 'working · reading files · 2:05');
    expect(lineColor(t), colors(t).accent);
    expect(find.byKey(const ValueKey('busy-dot')), findsOneWidget);
  });

  testWidgets('the phase follows the tool kind', (t) async {
    await r.open(t);
    r.tab!.clock = () => DateTime.now();
    r.event(user('u1'));
    final cases = {
      'Grep': 'searching',
      'Edit': 'editing',
      'Bash': 'running commands',
      'Task': 'delegating',
    };
    for (final MapEntry(:key, :value) in cases.entries) {
      r.event(tool('t$key', key));
      await flush(t);
      expect(lineText(t), startsWith('working · $value · '), reason: key);
      r.event(
        agent({
          't': 'tool-update',
          'id': 't$key',
          'text': 'ok',
          'isError': false,
        }),
      );
    }
  });

  testWidgets('working with no known phase: just working', (t) async {
    await r.open(t);
    r.event(user('u1'));
    await flush(t);
    expect(lineText(t), 'working');
    r.event(tool('t1', 'SomethingNew'));
    await flush(t);
    expect(lineText(t), 'working');
  });

  testWidgets('the elapsed time ticks every second', (t) async {
    await r.open(t);
    var now = DateTime(2026, 5, 1, 12);
    r.tab!.clock = () => now;
    r.event(user('u1'));
    r.event(tool('t1', 'Read'));
    await flush(t);
    expect(lineText(t), 'working · reading files · 0:00');
    now = now.add(const Duration(seconds: 3));
    await t.pump(const Duration(seconds: 1));
    expect(lineText(t), 'working · reading files · 0:03');
  });

  testWidgets('a pending permission: waiting for your answer, in accent', (
    t,
  ) async {
    await r.open(t);
    r.event(user('u1'));
    r.event({
      'kind': 'permission',
      'id': 'p1',
      'toolName': 'Bash',
      'input': {'command': 'ls'},
      'ts': 1,
    });
    await t.pumpAndSettle();
    expect(lineText(t), 'waiting for your answer');
    expect(lineColor(t), colors(t).accent);
  });

  testWidgets('compacting context', (t) async {
    await r.open(t);
    r.event(agent({'t': 'compacting'}));
    await flush(t);
    expect(lineText(t), 'compacting context…');
    expect(lineColor(t), colors(t).accent);
  });

  testWidgets('connecting before the window answers', (t) async {
    await r.open(t, replay: false);
    expect(lineText(t), 'connecting…');
    expect(lineColor(t), colors(t).mutedFg);
  });

  testWidgets('offline: the line says so, muted', (t) async {
    await r.open(t);
    r.ch.drop();
    await t.pumpAndSettle();
    expect(lineText(t), 'offline');
    expect(lineColor(t), colors(t).mutedFg);
  });

  testWidgets('the window gone: waiting for the window…', (t) async {
    await r.open(t);
    r.ch.host(Close(r.ch.lastWsId, 4904));
    await flush(t);
    expect(lineText(t), 'waiting for the window…');
    await t.pump(goneRetryAfter + const Duration(seconds: 1));
  });

  testWidgets('no status bar under the tabs in any state', (t) async {
    await r.open(t);
    expect(find.text('Working…'), findsNothing);
    r.event(user('u1'));
    await flush(t);
    expect(find.text('Working…'), findsNothing);
    r.ch.drop();
    await t.pumpAndSettle();
    expect(find.text('Offline'), findsNothing);
    expect(find.textContaining('Offline'), findsNothing);
  });

  testWidgets('a turn that ended well leaves no Done line in the feed', (
    t,
  ) async {
    await r.open(t);
    r.event(user('u1'));
    r.event(turnEnd());
    await t.pumpAndSettle();
    expect(find.textContaining('Done in'), findsNothing);
  });

  testWidgets('a stopped turn still says so', (t) async {
    await r.open(t);
    r.event(user('u1'));
    r.event(
      agent({
        't': 'turn-end',
        'stop': 'interrupted',
        'secs': 3,
        'answers': 'all',
        'queued': 0,
      }),
    );
    await t.pumpAndSettle();
    expect(find.textContaining('Stopped after'), findsOneWidget);
  });

  testWidgets('offline: seen N min ago, kept fresh by a slow ticker', (
    t,
  ) async {
    await r.open(t);
    r.link.stop();
    await t.pumpAndSettle();
    expect(lineText(t), 'offline · seen just now');
    final base = DateTime.now();
    r.tab!.clock = () => base.add(const Duration(minutes: 4));
    await t.pump(const Duration(seconds: 31));
    expect(lineText(t), 'offline · seen 4 min ago');
  });

  testWidgets('a window open elsewhere has its own line', (t) async {
    await r.open(t, replay: false);
    r.event({'kind': 'occupied'});
    await flush(t);
    expect(lineText(t), 'open in another tab');
    expect(lineColor(t), colors(t).mutedFg);
  });

  testWidgets('Stop and the ring have names and actions for TalkBack', (
    t,
  ) async {
    final h = t.ensureSemantics();
    await r.open(t);
    r.event(user('u1'));
    await flush(t);
    await flush(t);
    t.semantics.tap(find.semantics.byLabel('Stop'));
    await flush(t);
    expect(r.sent.last, {'type': 'interrupt'});
    h.dispose();
  });

  testWidgets('the feed keeps room for the floating Stop while working', (
    t,
  ) async {
    await r.open(t);
    double bottom() =>
        (t.widget<ListView>(find.byType(ListView).first).padding! as EdgeInsets)
            .bottom;
    final idle = bottom();
    r.event(user('u1'));
    await flush(t);
    expect(bottom(), greaterThanOrEqualTo(idle + 56));
  });

  group('window gone', () {
    testWidgets(
      'a spinner and the text over the feed; Retry only after 30 s; the draft stays',
      (t) async {
        await r.open(t);
        await t.enterText(find.byType(TextField), 'my draft');
        r.ch.host(Close(r.ch.lastWsId, 4904));
        await flush(t);
        expect(find.text('The window closed or restarted'), findsOneWidget);
        expect(find.text('Waiting for it to come back'), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(OneTabOverlay),
            matching: find.byType(CircularProgressIndicator),
          ),
          findsOneWidget,
        );
        expect(find.text('Retry'), findsNothing);
        await t.pump(const Duration(seconds: 29));
        expect(find.text('Retry'), findsNothing);
        await t.pump(const Duration(seconds: 2));
        expect(find.text('Retry'), findsOneWidget);
        expect(find.text('my draft'), findsOneWidget);
        // Retry opens the window again; the spinner stays and the wait starts over
        final before = r.ch.wsOpens.length;
        await t.tap(find.text('Retry'));
        await flush(t);
        expect(r.ch.wsOpens.length, before + 1);
        r.ch.host(Close(r.ch.lastWsId, 4904));
        await flush(t);
        expect(find.byType(CircularProgressIndicator), findsWidgets);
        expect(find.text('Retry'), findsNothing);
        await t.pump(goneRetryAfter + const Duration(seconds: 1));
        expect(find.text('Retry'), findsOneWidget);
      },
    );
  });
}
