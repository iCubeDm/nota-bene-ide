import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_route.dart';
import 'package:nb_app/chat/mermaid.dart';
import 'package:nb_app/chat/window_tab.dart';
import 'package:nb_app/comments/queue.dart';
import 'package:nb_app/hosts/host_link.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/store/hosts.dart';
import 'package:nb_app/notify/visible.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/sizes.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_app/store/voice_lang.dart';
import 'package:nb_app/voice/outbox.dart';
import 'package:nb_channel/nb_channel.dart';

import 'fakes.dart';
import 'mermaid_fake.dart';
import 'voice_fakes.dart';

/// A chat on a fake host: [ch] plays the window, [tab] is the phone's tab of it.
class Rig {
  late FakeChannel ch;
  late HostLink link;
  WindowTab? tab;

  /// The Settings choice of the voice language; none follows the app's.
  VoiceLang? voiceLang;

  /// Text and interface size; the phone's own without them.
  Sizes? sizes;

  Future<void> open(
    WidgetTester t, {
    List<Map<String, Object?>> events = const [],
    Map<String, Object?>? hello,
    Seen? seen,
    AppVisible? visible,
    HostWindow? win,
    // false when something on screen animates for good (a pulsing dot)
    bool settle = true,
    // the same app run: the voice outboxes keep what they have
    bool keepStore = false,
    // false: the window said hello and has not replayed yet (the tab is still connecting)
    bool replay = true,
  }) async {
    // the voice outboxes and the comment queues are the app's: each test starts with an empty disk
    if (!keepStore) {
      VoiceStore.instance = VoiceStore(MemoryOutFiles());
      CommentQueues.instance = CommentQueues(MemoryQueueFile());
    }
    final f = FakeFactory();
    ch = FakeChannel([win ?? window(4791, '/home/u/notes')]);
    f.results.add(ch);
    link = HostLink(
      PairedHost(
        id: b64u(List.filled(32, 1)),
        relay: Uri.parse('wss://r.example'),
        label: 'h',
        pairedAt: DateTime(2026),
      ),
      f.factory,
      await Identity.load(MemoryVault()),
      sleep: (_) => Completer<void>().future,
    )..start();
    await t.pump();
    await t.pumpWidget(
      NbApp(
        voiceLang: voiceLang,
        sizes: sizes,
        home: MermaidScope(
          renderer: FakeMermaid(),
          child: ChatRoute(
            link: link,
            port: 4791,
            root: '/home/u/notes',
            seen: seen,
            visible: visible,
            onTab: (x) => tab = x,
            retry: (_) async {},
          ),
        ),
      ),
    );
    await t.pump();
    event(hello ?? {'kind': 'hello', 'protocol': 13, 'capabilities': caps()});
    if (replay) event({'kind': 'replay', 'events': events});
    if (settle) {
      await t.pumpAndSettle();
    } else {
      await t.pump(const Duration(milliseconds: 100));
    }
  }

  static Map<String, Object?> caps({
    bool compact = true,
    bool models = true,
    bool usage = true,
    bool clear = true,
    List<String> modes = const ['default'],
    List<Map<String, Object?>>? modeDescriptors,
    String? provider,
    String? dictation,
  }) => {
    'provider': ?provider,
    'dictation': ?dictation,
    'compact': compact,
    'clear': clear,
    'modes': modes,
    'modeDescriptors': ?modeDescriptors,
    'usage': usage,
    'fileSuggestions': true,
    'fork': false,
    'idleCompact': true,
    'models': models,
  };

  /// Opens the context sheet through the ring, which shows once the window reported its context ([stats] is the stats
  /// event to report; a small context by default).
  Future<void> openContextSheet(
    WidgetTester t, {
    Map<String, Object?>? stats,
  }) async {
    event(
      stats ??
          {
            'kind': 'stats',
            'stats': {
              'context': {'used': 1000, 'max': 200000, 'pct': 0.5},
            },
          },
    );
    await t.pumpAndSettle();
    await t.tap(find.byKey(const ValueKey('context-ring')));
    await t.pumpAndSettle();
  }

  void event(Map<String, Object?> e) => ch.event(ch.lastWsId, e);

  /// What the phone sent on the window's socket.
  List<Map<String, Object?>> get sent => ch.sentOn(ch.lastWsId);

  void dispose() => link.dispose();
}

Map<String, Object?> agent(Map<String, Object?> e) => {
  'kind': 'agent',
  'e': e,
  'ts': 1,
};

Finder textIn(String s) => find.textContaining(s);

extension Pumps on WidgetTester {
  Future<void> enter(String text) async {
    await enterText(find.byType(TextField), text);
    await pump();
    // the mic and Send swap with a short animation: the old one must be gone before a tap
    await pump(const Duration(milliseconds: 200));
  }

  Future<void> tapText(String s) async {
    await tap(find.text(s));
    await pumpAndSettle();
  }
}

Widget unused() => const SizedBox();
