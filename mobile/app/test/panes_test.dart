import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/ui/folder_tabs.dart';
import 'package:nb_app/chat/chat_route.dart';
import 'package:nb_app/chat/composer.dart';
import 'package:nb_app/comments/comment_strip.dart';
import 'package:nb_app/comments/comments_pane.dart';
import 'package:nb_app/files/files_pane.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_app/voice/record_button.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'comments_test.dart' show c, json;
import 'support/fakes.dart';
import 'support/rig.dart';
import 'support/voice_fakes.dart';

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  Future<void> open(
    WidgetTester t, {
    List<Map<String, Object?>> events = const [],
    Size size = const Size(400, 800),
    Map<String, Object?>? hello,
  }) async {
    t.view.physicalSize = size;
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await r.open(t, events: events, hello: hello);
    r.ch.onHttp = (port, method, path) async {
      final u = Uri.parse(path);
      if (u.path == '/tree') {
        final d = u.queryParameters['path'] ?? '';
        return answer(
          200,
          jsonEncode(
            d.isEmpty
                ? [
                    {'name': 'src', 'dir': true},
                    {'name': 'a.txt', 'dir': false},
                  ]
                : [
                    {'name': 'main.dart', 'dir': false},
                  ],
          ),
        );
      }
      return answer(404, 'no');
    };
  }

  Future<void> swipe(WidgetTester t, double dx) async {
    await t.dragFrom(const Offset(200, 400), Offset(dx, 0));
    await t.pumpAndSettle();
  }

  testWidgets('the chat is shown first, with the strip of three tabs', (
    t,
  ) async {
    await open(t);
    expect(find.byType(Composer), findsOneWidget);
    for (final label in ['Files', 'Chat', 'Comments']) {
      expect(find.text(label), findsOneWidget);
    }
    final line = find.byKey(const ValueKey('strip-current'));
    final tabs = t.getSize(find.text('Chat'));
    expect(tabs.width, greaterThan(0));
    // the current tab's stadium sits on the middle tab
    expect(t.getCenter(line).dx, closeTo(200, 2));
    // the tabs float as a pill 8 dp in from the screen's edges
    final pill = t.getRect(find.byType(FolderTabs));
    expect(pill.left, 8);
    expect(pill.right, 392);
  });

  testWidgets('a swipe changes the pane and the current tab follows', (
    t,
  ) async {
    await open(t);
    await swipe(t, -300);
    expect(find.byType(CommentsPane), findsOneWidget);
    expect(
      find.text(
        'No comments yet. Select text in the chat or in a file and press Comment.',
      ),
      findsOneWidget,
    );
    final line = find.byKey(const ValueKey('strip-current'));
    expect(t.getCenter(line).dx, closeTo(8 + 384 / 3 * 2.5, 2));
    await swipe(t, 300);
    await swipe(t, 300);
    expect(find.byType(FilesPane), findsOneWidget);
    expect(t.getCenter(line).dx, closeTo(8 + 384 / 6, 2));
  });

  testWidgets('a tap on a tab switches too; back returns to the chat first', (
    t,
  ) async {
    await open(t);
    await t.tap(find.text('Comments'));
    await t.pumpAndSettle();
    expect(
      find
          .text(
            'No comments yet. Select text in the chat or in a file and press Comment.',
          )
          .hitTestable(),
      findsOneWidget,
    );
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    expect(find.byType(Composer).hitTestable(), findsOneWidget);
    expect(find.byType(ChatRoute), findsOneWidget);
  });

  testWidgets('back in Files goes up a folder, then to the chat', (t) async {
    await open(t);
    await t.tap(find.text('Files'));
    await t.pumpAndSettle();
    await t.tap(find.text('src'));
    await t.pumpAndSettle();
    expect(find.text('main.dart'), findsOneWidget);
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    expect(find.text('a.txt').hitTestable(), findsOneWidget);
    expect(find.text('main.dart'), findsNothing);
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    expect(find.byType(Composer).hitTestable(), findsOneWidget);
  });

  testWidgets('the header has no agent menu: Files is a tab', (t) async {
    await open(t);
    expect(find.byTooltip('Agent'), findsNothing);
    expect(find.byType(PopupMenuButton<Object?>), findsNothing);
  });

  testWidgets(
    'a wide screen stands the three side by side, without the strip',
    (t) async {
      await open(t, size: const Size(1000, 700));
      expect(find.byType(FilesPane), findsOneWidget);
      expect(find.byType(CommentsPane), findsOneWidget);
      expect(find.byType(Composer), findsOneWidget);
      expect(find.byKey(const ValueKey('strip-current')), findsNothing);
      final files = t.getRect(find.byType(FilesPane));
      final chat = t.getRect(find.byType(Composer));
      final comments = t.getRect(find.byType(CommentsPane));
      expect(files.right, lessThanOrEqualTo(chat.left));
      expect(chat.right, lessThanOrEqualTo(comments.left));
    },
  );

  testWidgets('inner horizontal scrolling wins over the swipe', (t) async {
    await open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'code', 'ts': 1, 'historic': true},
        agent({'t': 'message', 'id': 'a1', 'text': '```\n${'x' * 300}\n```'}),
      ],
    );
    await t.dragFrom(
      t.getCenter(find.textContaining('xxxxxxxxxx')),
      const Offset(-150, 0),
    );
    await t.pumpAndSettle();
    expect(find.byType(Composer).hitTestable(), findsOneWidget);
  });

  testWidgets('a folder opened in Files starts below the header and strip', (
    t,
  ) async {
    await open(t);
    await t.tap(find.text('Files'));
    await t.pumpAndSettle();
    await t.tap(find.text('src'));
    await t.pumpAndSettle();
    // the header (8 + 40 + 8) and the strip (40) float over the page
    expect(
      t.getTopLeft(find.byKey(const ValueKey('folder-path'))).dy,
      greaterThanOrEqualTo(96),
    );
  });

  testWidgets(
    'wide: back goes up a folder in Files before it leaves the chat',
    (t) async {
      await open(t);
      await t.tap(find.text('Files'));
      await t.pumpAndSettle();
      await t.tap(find.text('src'));
      await t.pumpAndSettle();
      t.view.physicalSize = const Size(1000, 700);
      await t.pumpAndSettle();
      expect(find.text('main.dart'), findsOneWidget);
      await t.binding.handlePopRoute();
      await t.pumpAndSettle();
      expect(find.text('main.dart'), findsNothing);
      expect(find.text('a.txt'), findsOneWidget);
      expect(find.byType(ChatRoute), findsOneWidget);
    },
  );

  testWidgets('narrow again after a rotation starts at the chat', (t) async {
    await open(t);
    await t.tap(find.text('Files'));
    await t.pumpAndSettle();
    t.view.physicalSize = const Size(1000, 700);
    await t.pumpAndSettle();
    t.view.physicalSize = const Size(400, 800);
    await t.pumpAndSettle();
    // narrow again starts at the chat, and the strip says so
    expect(find.byType(Composer).hitTestable(), findsOneWidget);
    expect(
      t.getCenter(find.byKey(const ValueKey('strip-current'))).dx,
      closeTo(200, 2),
    );
  });

  group('the chat pane outlives the others', () {
    testWidgets('a swipe to Files and back keeps the same composer', (t) async {
      await open(t);
      final before = t.state(find.byType(Composer));
      await t.tap(find.text('Files'));
      await t.pumpAndSettle();
      await t.tap(find.text('Chat'));
      await t.pumpAndSettle();
      expect(t.state(find.byType(Composer)), same(before));
    });

    testWidgets('rotating across the wide width keeps the panes', (t) async {
      await open(t);
      await t.tap(find.text('Comments'));
      await t.pumpAndSettle();
      await t.tap(find.text('Chat'));
      await t.pumpAndSettle();
      final composer = t.state(find.byType(Composer));
      final comments = t.state(find.byType(CommentsPane, skipOffstage: false));
      t.view.physicalSize = const Size(1000, 700);
      await t.pumpAndSettle();
      expect(t.state(find.byType(Composer)), same(composer));
      expect(t.state(find.byType(CommentsPane)), same(comments));
      t.view.physicalSize = const Size(400, 800);
      await t.pumpAndSettle();
      expect(t.state(find.byType(Composer)), same(composer));
    });

    group('with a recording', () {
      late RecorderMock rec;
      setUp(() {
        rec = RecorderMock()..install();
        VoicePlayer.shared = VoicePlayer(files: MemoryVoiceFiles());
      });
      tearDown(() => rec.uninstall());

      testWidgets('a tab does not switch away silently', (t) async {
        // a common phone's width: the locked recording's row fits it
        await open(
          t,
          size: const Size(360, 800),
          hello: {
            'kind': 'hello',
            'protocol': 14,
            'capabilities': Rig.caps(dictation: 'whisper'),
          },
        );
        final line = find.byKey(const ValueKey('strip-current'));
        final g = await t.startGesture(t.getCenter(find.byType(RecordButton)));
        await t.pump(const Duration(milliseconds: 300));
        await g.moveBy(const Offset(0, -90));
        await g.up();
        await t.pump();
        await t.tap(find.text('Files'));
        await t.pumpAndSettle();
        expect(t.getCenter(line).dx, closeTo(180, 2));
        expect(
          find.text('Finish or delete the voice message first.'),
          findsOneWidget,
        );
      });
    });
  });

  group('the comments pane', () {
    Map<String, Object?> sent(String id, String sentIn, String text) => {
      ...json(
        c(
          id,
          'quote $id',
          text,
          source: AnchorSourceMessage(id: sentIn),
          status: CommentStatus.sent,
        ),
      ),
      'sentIn': sentIn,
    };

    final msgs = [
      for (var i = 0; i < 40; i++) ...[
        {
          'kind': 'user',
          'id': 'u$i',
          'text': 'message number $i',
          'ts': 1,
          'historic': true,
        },
        agent({'t': 'message', 'id': 'a$i', 'text': 'reply number $i'}),
      ],
    ];

    testWidgets(
      'pending on top with a count badge and Send; sent below, folded, by message',
      (t) async {
        await open(t, events: msgs);
        r.event({
          'kind': 'comments',
          'items': [
            json(
              c(
                'p',
                'pending quote',
                'fix this',
                source: const AnchorSourceMessage(id: 'u39'),
              ),
            ),
            sent('s1', 'u1', 'old note'),
            sent('s2', 'u1', 'another'),
            sent('s3', 'u2', 'third'),
          ],
        });
        await t.pumpAndSettle();
        expect(find.byKey(const ValueKey('badge-2')), findsOneWidget);
        await t.tap(find.text('Comments'));
        await t.pumpAndSettle();
        expect(find.text('1 comment to send'), findsOneWidget);
        expect(find.textContaining('fix this'), findsOneWidget);
        // the sent ones are folded under their count until the heading is tapped
        expect(find.text('Sent · 3'), findsOneWidget);
        expect(find.textContaining('old note'), findsNothing);
        expect(find.text('message number 1'), findsNothing);
        await t.tap(find.byKey(const ValueKey('sent-fold')));
        await t.pumpAndSettle();
        // grouped under the message they went with
        expect(find.text('message number 1'), findsOneWidget);
        expect(find.text('message number 2'), findsOneWidget);
        expect(find.textContaining('old note'), findsOneWidget);
        expect(find.textContaining('third'), findsOneWidget);
        // Send sends the pending comments alone
        await t.tap(find.widgetWithText(FilledButton, 'Send'));
        await t.pumpAndSettle();
        final m = r.sent.lastWhere((m) => m['type'] == 'send');
        expect(m['commentIds'], ['p']);
        expect(m['text'], startsWith('Comments on fragments:'));
      },
    );

    testWidgets('a tap on a chat comment shows the chat at its message', (
      t,
    ) async {
      await open(t, events: msgs);
      r.event({
        'kind': 'comments',
        'items': [sent('s1', 'u0', 'about the first one')],
      });
      await t.pumpAndSettle();
      expect(find.text('message number 0'), findsNothing);
      await t.tap(find.text('Comments'));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const ValueKey('sent-fold')));
      await t.pumpAndSettle();
      await t.tap(find.textContaining('about the first one'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      await t.pump(const Duration(seconds: 2));
      await t.pumpAndSettle();
      expect(find.byType(Composer).hitTestable(), findsOneWidget);
      expect(find.text('message number 0').hitTestable(), findsOneWidget);
    });
  });

  group('the mode under Chat', () {
    Map<String, Object?> hello(List<String> modes) => {
      'kind': 'hello',
      'protocol': 13,
      'capabilities': Rig.caps(modes: modes),
    };

    testWidgets('written small under the label, danger without prompts', (
      t,
    ) async {
      await open(t, hello: hello(['default', 'auto']));
      expect(find.byKey(const ValueKey('sub-1')), findsNothing);
      r.event({'kind': 'mode', 'mode': 'default'});
      await t.pumpAndSettle();
      final sub = find.byKey(const ValueKey('sub-1'));
      expect(t.widget<Text>(sub).data, webString('mode_default', 'en'));
      final c = Theme.of(t.element(sub)).extension<NbColors>()!;
      expect(t.widget<Text>(sub).style!.color, c.mutedFg);
      r.event({'kind': 'mode', 'mode': 'auto'});
      await t.pumpAndSettle();
      expect(t.widget<Text>(sub).data, webString('mode_auto', 'en'));
      expect(t.widget<Text>(sub).style!.color, c.destructive);
    });

    testWidgets('not written when the agent offers one mode', (t) async {
      await open(t, hello: hello(['default']));
      r.event({'kind': 'mode', 'mode': 'default'});
      await t.pumpAndSettle();
      expect(find.byKey(const ValueKey('sub-1')), findsNothing);
    });
  });

  group('the comment strip', () {
    Future<void> pend(WidgetTester t) async {
      r.event({
        'kind': 'comments',
        'items': [
          json(c('p', 'quoted words', 'fix this')),
          json(c('q', 'more words', 'and this')),
        ],
      });
      await t.pumpAndSettle();
    }

    testWidgets('is one line with the count and no comment text', (t) async {
      await open(t);
      await pend(t);
      final strip = find.byType(CommentStrip);
      expect(
        find.descendant(of: strip, matching: find.text('2 comments to send')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: strip, matching: find.byType(Text)),
        findsOneWidget,
      );
      expect(find.textContaining('fix this'), findsNothing);
      expect(t.getSize(strip).height, lessThan(44));
    });

    testWidgets('the pane shows a comment\'s clips after its typed text', (
      t,
    ) async {
      await open(t);
      final withClip = json(c('p', 'quoted words', 'typed'))
        ..['voice'] = [
          {
            'text': 'said this',
            'id': 'a' * 64,
            'ms': 1000,
            'wave': List.filled(48, 1),
          },
        ];
      r.event({
        'kind': 'comments',
        'items': [withClip],
      });
      await t.pumpAndSettle();
      await t.tap(find.text('Comments'));
      await t.pumpAndSettle();
      expect(
        find.textContaining('typed said this', findRichText: true),
        findsOneWidget,
      );
    });

    testWidgets('a tap opens the Comments pane', (t) async {
      await open(t);
      await pend(t);
      expect(find.byType(CommentsPane), findsNothing);
      await t.tap(find.byType(CommentStrip));
      await t.pumpAndSettle();
      expect(find.textContaining('fix this').hitTestable(), findsOneWidget);
      expect(find.byType(Composer).hitTestable(), findsNothing);
    });
  });
}
