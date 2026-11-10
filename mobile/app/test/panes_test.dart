import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/chat_route.dart';
import 'package:nb_app/chat/composer.dart';
import 'package:nb_app/comments/comments_pane.dart';
import 'package:nb_app/files/files_pane.dart';
import 'package:nb_protocol/nb_protocol.dart';

import 'comments_test.dart' show c, json;
import 'support/fakes.dart';
import 'support/rig.dart';

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  Future<void> open(
    WidgetTester t, {
    List<Map<String, Object?>> events = const [],
    Size size = const Size(400, 800),
  }) async {
    t.view.physicalSize = size;
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await r.open(t, events: events);
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
    final line = find.byKey(const ValueKey('strip-underline'));
    final tabs = t.getSize(find.text('Chat'));
    expect(tabs.width, greaterThan(0));
    // the underline sits under the middle tab
    expect(t.getCenter(line).dx, closeTo(200, 2));
  });

  testWidgets('a swipe changes the pane and the underline follows', (t) async {
    await open(t);
    await swipe(t, -300);
    expect(find.byType(CommentsPane), findsOneWidget);
    expect(
      find.text(
        'No comments yet. Select text in the chat or in a file and press Comment.',
      ),
      findsOneWidget,
    );
    final line = find.byKey(const ValueKey('strip-underline'));
    expect(t.getCenter(line).dx, closeTo(400 / 3 * 2.5, 2));
    await swipe(t, 300);
    await swipe(t, 300);
    expect(find.byType(FilesPane), findsOneWidget);
    expect(t.getCenter(line).dx, closeTo(400 / 6, 2));
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

  testWidgets('the menu\'s Files switches to the Files pane', (t) async {
    await open(t);
    await t.tap(find.byTooltip('Agent'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(PopupMenuItem<Object?>, 'Files'));
    await t.pumpAndSettle();
    expect(find.text('a.txt').hitTestable(), findsOneWidget);
  });

  testWidgets(
    'a wide screen stands the three side by side, without the strip',
    (t) async {
      await open(t, size: const Size(1000, 700));
      expect(find.byType(FilesPane), findsOneWidget);
      expect(find.byType(CommentsPane), findsOneWidget);
      expect(find.byType(Composer), findsOneWidget);
      expect(find.byKey(const ValueKey('strip-underline')), findsNothing);
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
      'pending on top with a count badge and Send; sent below, by message',
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
        expect(find.byKey(const ValueKey('comments-badge')), findsOneWidget);
        await t.tap(find.text('Comments'));
        await t.pumpAndSettle();
        expect(find.text('1 comment to send'), findsOneWidget);
        expect(find.textContaining('fix this'), findsOneWidget);
        expect(find.text('Sent'), findsOneWidget);
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
      await t.tap(find.textContaining('about the first one'));
      await t.pumpAndSettle(const Duration(milliseconds: 100));
      await t.pump(const Duration(seconds: 2));
      await t.pumpAndSettle();
      expect(find.byType(Composer).hitTestable(), findsOneWidget);
      expect(find.text('message number 0').hitTestable(), findsOneWidget);
    });
  });
}
