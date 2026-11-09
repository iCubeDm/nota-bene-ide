// The phone's chat anchors against the desktop's (web/src/anchors/mobileChatParity.test.tsx).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/feed.dart';
import 'package:nb_app/comments/anchor.dart';
import 'package:nb_app/comments/chat_anchor.dart';
import 'package:nb_protocol/nb_protocol.dart';

void main() {
  group('chatSource', () {
    test('a user message and a final reply', () {
      expect(
        (chatSource(UserItem('u1', 'hi')) as AnchorSourceMessage).id,
        'u1',
      );
      expect(
        (chatSource(AssistantItem('a1', 'x', final_: true))
                as AnchorSourceMessage)
            .id,
        'a1',
      );
    });

    test('a reply still streaming, a tool and a line have none', () {
      expect(chatSource(AssistantItem('stream:0', 'x', final_: false)), isNull);
      expect(
        chatSource(ToolItem('t1', 'Bash', 'ls', const {}, sub: false)),
        isNull,
      );
      expect(chatSource(UserItem('u2', '', idle: true)), isNull);
    });
  });

  group('chatText, against the desktop', () {
    final files =
        Directory('test/fixtures/chat')
            .listSync()
            .whereType<File>()
            .where((f) => f.path.endsWith('.md'))
            .toList()
          ..sort((a, b) => a.path.compareTo(b.path));

    test('there are fixtures', () => expect(files.length, greaterThan(4)));

    for (final f in files) {
      final name = f.uri.pathSegments.last;
      test('$name matches the desktop', () {
        final raw = f.readAsStringSync();
        final want = File(
          f.path.replaceAll(RegExp(r'\.md$'), '.txt'),
        ).readAsStringSync();
        final item = name.startsWith('user-')
            ? UserItem('m1', raw)
            : AssistantItem('m1', raw, final_: true);
        expect(chatText(item).text, want);
      });
    }

    test(
      'a heading, a list, inline code and a fenced block are in a reply',
      () {
        final t = chatText(
          AssistantItem(
            'a',
            '# Head\n\n- one\n- `two`\n\n```\ncode  x\n```',
            final_: true,
          ),
        ).text;
        expect(t, 'Head one two code x');
      },
    );

    test('an anchor on the second of two equal quotes resolves to it', () {
      final r = chatText(AssistantItem('a', 'cache and cache', final_: true));
      final a = makeAnchor(const AnchorSourceMessage(id: 'a'), r.text, 10, 15);
      expect(resolveAnchor(a, r.text), (start: 10, end: 15));
    });
  });

  group('whereOfChat', () {
    final feed = Feed()
      ..items = [UserItem('u1', 'hi'), AssistantItem('a1', 'x', final_: true)];
    test('a message, a reply, and one the feed does not hold', () {
      expect(whereOfChat('u1', feed, 'en'), 'my message');
      expect(whereOfChat('a1', feed, 'en'), 'reply');
      expect(whereOfChat('old', feed, 'en'), 'chat');
    });
  });
}
