import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:nb_app/voice/record_button.dart';
import 'package:nb_app/voice/record_row.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_channel/nb_channel.dart';

import 'support/rig.dart';
import 'support/voice_fakes.dart';

void main() {
  late Rig r;
  setUp(() => r = Rig());
  tearDown(() => r.dispose());

  testWidgets('send writes a send message and clears the field', (t) async {
    await r.open(t);
    await t.enter('Next step please');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    final m = r.sent.single;
    expect((m['type'], m['text']), ('send', 'Next step please'));
    expect(m['id'], matches(RegExp(r'^[0-9a-f-]{36}$')));
    expect(m.containsKey('force'), isFalse);
    expect(find.text('Next step please'), findsNothing);
  });

  testWidgets('send while busy asks and sends force', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.enter('Change of plan');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    expect(textIn('interrupt'), findsWidgets);
    await t.tapText('Send now');
    expect(r.sent.single['force'], isTrue);
  });

  testWidgets('while busy a message can wait for its turn instead', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.enter('After that, this');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    await t.tapText('Send after this turn');
    final m = r.sent.single;
    expect((m['text'], m.containsKey('force')), ('After that, this', false));
  });

  testWidgets('a send that cannot go keeps the text', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.enter('Keep me');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    r.event({
      'kind': 'occupied',
    }); // another tab took the window while the dialog was up
    await t.pumpAndSettle();
    await t.tapText('Send now');
    expect(r.sent, isEmpty);
    expect(find.text('Keep me'), findsOneWidget);
  });

  testWidgets('send-refused keeps the text', (t) async {
    await r.open(t);
    await t.enter('Hello');
    await t.tap(find.byTooltip('Send'));
    await t.pumpAndSettle();
    r.event({
      'kind': 'send-refused',
      'id': r.sent.single['id'],
      'reason': 'switching',
    });
    await t.pumpAndSettle();
    expect(find.text('Hello'), findsOneWidget);
    expect(find.byType(SnackBar), findsOneWidget);
  });

  testWidgets('stop is offered while busy and sends interrupt', (t) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
      ],
    );
    await t.tap(find.byTooltip('Stop'));
    await t.pumpAndSettle();
    expect(r.sent.single, {'type': 'interrupt'});
  });

  testWidgets('offline disables sending and shows the last-seen time', (
    t,
  ) async {
    await r.open(t);
    r.ch.drop();
    await t.pumpAndSettle();
    expect(textIn('Offline'), findsWidgets);
    final field = t.widget<TextField>(find.byType(TextField));
    expect(field.enabled, isFalse);
    expect(
      t.widget<IconButton>(find.byKey(const ValueKey('send'))).onPressed,
      isNull,
    );
  });

  testWidgets('send is always there, disabled while there is nothing to send', (
    t,
  ) async {
    await r.open(t);
    final send = find.byKey(const ValueKey('send'));
    expect(send, findsOneWidget);
    expect(t.widget<IconButton>(send).onPressed, isNull);
    await t.enter('x');
    expect(t.widget<IconButton>(send).onPressed, isNotNull);
  });

  testWidgets(
    'busy: Stop sits beside Send, which is off until there is something to send',
    (t) async {
      await r.open(
        t,
        events: [
          {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
        ],
      );
      expect(find.byTooltip('Stop'), findsOneWidget);
      final send = find.byKey(const ValueKey('send'));
      expect(t.widget<IconButton>(send).onPressed, isNull);
      await t.enter('more');
      expect(find.byTooltip('Stop'), findsOneWidget);
      expect(t.widget<IconButton>(send).onPressed, isNotNull);
      await t.tap(find.byKey(const ValueKey('send')));
      await t.pumpAndSettle();
      expect(textIn('interrupt'), findsWidgets);
    },
  );

  testWidgets('the feed ends above the composer, also with the keyboard up', (
    t,
  ) async {
    await r.open(
      t,
      events: [
        {'kind': 'user', 'id': 'u1', 'text': 'newest words', 'ts': 1},
      ],
    );
    double gap() =>
        t.getTopLeft(find.byKey(const ValueKey('composer'))).dy -
        t.getBottomLeft(find.text('newest words')).dy;
    expect(gap(), greaterThanOrEqualTo(0));
    t.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(t.view.resetViewInsets);
    await t.pumpAndSettle();
    expect(gap(), greaterThanOrEqualTo(0));
  });

  group('voice', () {
    late RecorderMock rec;
    setUp(() {
      rec = RecorderMock()..install();
      VoicePlayer.shared = VoicePlayer(files: MemoryVoiceFiles());
    });
    tearDown(() => rec.uninstall());

    final voice = {'id': 'e' * 64, 'ms': 2000, 'wave': List.filled(48, 5)};
    HttpAnswer ok() => (
      status: 200,
      headers: const <String, String>{},
      body: Uint8List.fromList(utf8.encode(jsonEncode(voice))),
    );
    HttpAnswer refuse(int status) =>
        (status: status, headers: const <String, String>{}, body: Uint8List(0));

    Future<void> openVoice(
      WidgetTester t, {
      int protocol = 14,
      String? dictation = 'whisper',
      List<Map<String, Object?>> events = const [],
    }) => r.open(
      t,
      events: events,
      hello: {
        'kind': 'hello',
        'protocol': protocol,
        'capabilities': Rig.caps(dictation: dictation),
      },
    );

    Future<void> record(WidgetTester t) async {
      final g = await t.startGesture(t.getCenter(find.byType(RecordButton)));
      await t.pump(const Duration(milliseconds: 700));
      await g.up();
      await t.pump();
      await t.pump();
    }

    testWidgets(
      'the mic is the round button while there is nothing to send; typing makes it Send',
      (t) async {
        await openVoice(t);
        expect(find.byType(RecordButton), findsOneWidget);
        expect(find.byKey(const ValueKey('send')), findsNothing);
        expect(t.getSize(find.byType(RecordButton)), const Size(48, 48));
        await t.enter('x');
        await t.pumpAndSettle();
        expect(find.byType(RecordButton), findsNothing);
        expect(
          t.getSize(find.byKey(const ValueKey('send'))),
          const Size(48, 48),
        );
        await t.enter('');
        await t.pumpAndSettle();
        expect(find.byType(RecordButton), findsOneWidget);
      },
    );

    testWidgets('no mic below protocol 14', (t) async {
      await openVoice(t, protocol: 13);
      expect(find.byType(RecordButton), findsNothing);
      expect(find.byKey(const ValueKey('send')), findsOneWidget);
    });

    testWidgets('without Whisper the mic opens its sheet', (t) async {
      await openVoice(t, dictation: null);
      await t.tap(find.byType(RecordButton));
      await t.pumpAndSettle();
      expect(find.text('Dictation by Whisper'), findsOneWidget);
    });

    testWidgets(
      'the paperclip is in the field, and moves to its top once the text wraps',
      (t) async {
        await openVoice(t);
        final clip = find.byKey(const ValueKey('attach'));
        final field = find.byType(TextField);
        expect(t.getCenter(clip).dy, greaterThan(t.getTopLeft(field).dy));
        expect(
          t.getCenter(clip).dx,
          greaterThan(t.getBottomRight(field).dx - 60),
        );
        await t.enter('word ' * 80);
        await t.pumpAndSettle();
        expect(
          t.getBottomLeft(clip).dy,
          lessThanOrEqualTo(t.getTopLeft(field).dy + 1),
        );
        // the text has the field's full width below it
        await t.enter('short');
        await t.pumpAndSettle();
        expect(t.getCenter(clip).dy, greaterThan(t.getTopLeft(field).dy));
      },
    );

    testWidgets(
      'a recording is uploaded, then sent as a voice message, with the pending bubble between',
      (t) async {
        await openVoice(t);
        final up = Completer<HttpAnswer>();
        r.ch.onHttp = (port, method, path) => up.future;
        await record(t);
        expect(rec.calls, ['start', 'stop']);
        expect(r.ch.requests, ['POST /voice']);
        expect(r.ch.calls.single.headers['content-type'], 'audio/wav');
        expect(r.sent, isEmpty);
        expect(find.text('Sending…'), findsOneWidget);
        up.complete(ok());
        await t.pump();
        await t.pump();
        final m = r.sent.single;
        expect(m['type'], 'send');
        expect(m['text'], '');
        expect(m['voice'], voice);
        expect(m['lang'], 'en');
        expect(m['id'], matches(RegExp(r'^[0-9a-f-]{36}$')));
        for (final k in ['force', 'images', 'commentIds']) {
          expect(m.containsKey(k), isFalse, reason: k);
        }
        // the window's user event replaces the pending bubble
        r.event({
          'kind': 'user',
          'id': m['id'],
          'text': '',
          'voice': voice,
          'ts': 1,
        });
        await t.pump();
        expect(find.text('Sending…'), findsNothing);
        expect(find.text('Transcribing…'), findsOneWidget);
      },
    );

    testWidgets(
      'while the agent works a voice message goes without the dialog, after the turn',
      (t) async {
        await openVoice(
          t,
          events: [
            {'kind': 'user', 'id': 'u1', 'text': 'go', 'ts': 1},
          ],
        );
        r.ch.onHttp = (port, method, path) async => ok();
        // Stop sits beside the mic
        expect(find.byTooltip('Stop'), findsOneWidget);
        expect(
          t.getSize(find.byKey(const ValueKey('stop'))),
          const Size(40, 40),
        );
        expect(find.byType(RecordButton), findsOneWidget);
        await record(t);
        expect(find.byType(AlertDialog), findsNothing);
        expect(r.sent.single.containsKey('force'), isFalse);
        expect(r.sent.single['voice'], voice);
      },
    );

    testWidgets(
      'a failed upload stays as a bubble with Retry and is sent after it',
      (t) async {
        await openVoice(t);
        r.ch.onHttp = (port, method, path) async => refuse(500);
        await record(t);
        expect(r.sent, isEmpty);
        expect(find.text('Could not send the recording'), findsOneWidget);
        r.ch.onHttp = (port, method, path) async => ok();
        await t.tap(find.text('Retry'));
        await t.pump();
        await t.pump();
        expect(r.sent.single['voice'], voice);
        expect(r.ch.requests, ['POST /voice', 'POST /voice']);
      },
    );

    testWidgets(
      'a send the window does not take stays as a bubble with Retry',
      (t) async {
        await openVoice(t);
        r.ch.onHttp = (port, method, path) async => ok();
        await record(t);
        final id = r.sent.single['id'];
        r.event({'kind': 'send-refused', 'id': id, 'reason': 'switching'});
        await t.pump();
        expect(find.text('Could not send the recording'), findsOneWidget);
        await t.tap(find.text('Retry'));
        await t.pump();
        expect(r.sent, hasLength(2));
        expect(r.sent.last['id'], isNot(id));
        // no second upload: the host has the recording
        expect(r.ch.requests, ['POST /voice']);
      },
    );

    testWidgets(
      'leaving the chat keeps a failed voice message: it is there, with Retry, when the chat opens again',
      (t) async {
        await openVoice(t);
        r.ch.onHttp = (port, method, path) async => refuse(500);
        await record(t);
        expect(find.text('Could not send the recording'), findsOneWidget);
        // back out of the chat: the route and its tab are gone
        await t.pumpWidget(const SizedBox());
        r.dispose();
        r = Rig();
        await r.open(
          t,
          keepStore: true,
          hello: {
            'kind': 'hello',
            'protocol': 14,
            'capabilities': Rig.caps(dictation: 'whisper'),
          },
        );
        expect(find.text('Could not send the recording'), findsOneWidget);
        r.ch.onHttp = (port, method, path) async => ok();
        await t.tap(find.text('Retry'));
        await t.pump();
        await t.pump();
        expect(r.sent.single['voice'], voice);
      },
    );

    testWidgets(
      'leaving the chat while the recording uploads: it goes out when the chat opens again',
      (t) async {
        await openVoice(t);
        final up = Completer<HttpAnswer>();
        r.ch.onHttp = (port, method, path) => up.future;
        await record(t);
        await t.pumpWidget(const SizedBox());
        up.complete(ok());
        await t.pump();
        r.dispose();
        r = Rig();
        await r.open(
          t,
          keepStore: true,
          hello: {
            'kind': 'hello',
            'protocol': 14,
            'capabilities': Rig.caps(dictation: 'whisper'),
          },
        );
        await t.pump();
        await t.pump();
        expect(r.sent.single['voice'], voice);
        expect(r.sent.single['text'], '');
      },
    );

    Future<void> lockedPreview(WidgetTester t) async {
      final g = await t.startGesture(t.getCenter(find.byType(RecordButton)));
      await t.pump(const Duration(milliseconds: 300));
      await g.moveBy(const Offset(0, -90));
      await g.up();
      await t.pump();
    }

    testWidgets(
      'leaving the chat with a locked recording asks; Delete drops it',
      (t) async {
        await openVoice(t);
        await lockedPreview(t);
        await t.binding.handlePopRoute();
        await t.pumpAndSettle();
        expect(find.text('Send the voice message?'), findsOneWidget);
        // the recording stopped into the preview, not lost
        expect(rec.calls, ['start', 'stop']);
        await t.tap(find.text('Delete'));
        await t.pumpAndSettle();
        expect(r.ch.requests, isEmpty);
        expect(find.byType(RecordButton), findsOneWidget);
        expect(find.text('Send the voice message?'), findsNothing);
      },
    );

    testWidgets('leaving the chat with a recording: Send sends it', (t) async {
      await openVoice(t);
      r.ch.onHttp = (port, method, path) async => ok();
      await lockedPreview(t);
      await t.binding.handlePopRoute();
      await t.pumpAndSettle();
      await t.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Send'),
        ),
      );
      await t.pump();
      await t.pump();
      expect(r.sent.single['voice'], voice);
    });

    testWidgets('Cancel in that question stays with the recording', (t) async {
      await openVoice(t);
      await lockedPreview(t);
      await t.binding.handlePopRoute();
      await t.pumpAndSettle();
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
      expect(find.byType(RecordRow), findsOneWidget);
      expect(r.sent, isEmpty);
    });

    testWidgets(
      'the recording takes the field row; locked and stopped it shows its preview',
      (t) async {
        await openVoice(t);
        r.ch.onHttp = (port, method, path) async => ok();
        final g = await t.startGesture(t.getCenter(find.byType(RecordButton)));
        await t.pump(const Duration(milliseconds: 300));
        expect(find.text('Slide to cancel'), findsOneWidget);
        await g.moveBy(const Offset(0, -90));
        await g.up();
        await t.pump();
        await t.tap(find.byTooltip('Stop'));
        await t.pump();
        expect(find.byType(RecordRow), findsOneWidget);
        expect(find.byTooltip('Delete'), findsOneWidget);
        await t.tap(find.byTooltip('Send'));
        await t.pump();
        await t.pump();
        expect(r.sent.single['voice'], voice);
      },
    );
  });
}
