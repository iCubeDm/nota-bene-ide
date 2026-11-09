import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comment_sheet.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_app/chat/composer.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_app/voice/record_button.dart';
import 'package:nb_app/voice/record_row.dart';
import 'package:nb_protocol/nb_protocol.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/theme.dart';

import 'support/rig.dart';
import 'support/voice_fakes.dart';

void main() {
  SheetResult? got;

  Future<void> open(WidgetTester t) async {
    got = null;
    await t.pumpWidget(
      NbApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async =>
                got = await showCommentSheet(context, quote: 'a quote'),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await t.tap(find.text('open'));
    await t.pumpAndSettle();
  }

  Finder circle(QuickLabel l) => find.byKey(ValueKey('label:${l.id.name}'));

  testWidgets('the label row shows emoji only, in 32 px circles', (t) async {
    await open(t);
    for (final l in quickLabels) {
      expect(find.text(l.emoji), findsOneWidget);
      expect(t.getSize(circle(l)), const Size(32, 32));
      expect(find.textContaining(l.textIn('en')), findsNothing);
    }
    expect(find.byType(ChoiceChip), findsNothing);
  });

  testWidgets('the selected emoji is ringed in the accent', (t) async {
    await open(t);
    final accent = Theme.of(
      t.element(find.byType(TextField)),
    ).extension<NbColors>()!.accent;
    Color? ring(QuickLabel l) {
      final box = t.widget<Container>(circle(l)).decoration as BoxDecoration?;
      return box?.border?.top.color;
    }

    final a = quickLabels[0], b = quickLabels[1];
    expect(ring(a), isNot(accent));
    await t.tap(circle(a));
    await t.pump();
    expect(ring(a), accent);
    expect(ring(b), isNot(accent));
    await t.tap(circle(b));
    await t.pump();
    expect(ring(a), isNot(accent));
    expect(ring(b), accent);
  });

  testWidgets('long-press on an emoji names it in a tooltip', (t) async {
    await open(t);
    final l = quickLabels[2];
    await t.longPress(circle(l));
    await t.pumpAndSettle();
    expect(find.text(l.textIn('en')), findsOneWidget);
  });

  testWidgets('selecting and saving returns the label', (t) async {
    await open(t);
    final l = quickLabels[1];
    await t.tap(circle(l));
    await t.enterText(find.byType(TextField), 'because');
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final r = got as SheetSave;
    expect((r.label, r.text), (l.id, 'because'));
  });

  testWidgets('tapping the selected emoji clears the label', (t) async {
    await open(t);
    final l = quickLabels[1];
    await t.tap(circle(l));
    await t.tap(circle(l));
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    expect((got as SheetSave).label, isNull);
  });

  group('voice clips', () {
    late Rig r;
    late RecorderMock rec;
    var n = 0;
    Completer<void>? hold;
    int textStatus = 200;
    setUp(() {
      r = Rig();
      rec = RecorderMock()..install();
      VoicePlayer.shared = VoicePlayer(files: MemoryVoiceFiles());
      n = 0;
      hold = null;
      textStatus = 200;
    });
    tearDown(() {
      rec.uninstall();
      r.dispose();
    });

    HttpAnswer json(int status, Object? body) => (
      status: status,
      headers: const <String, String>{},
      body: Uint8List.fromList(utf8.encode(jsonEncode(body ?? {}))),
    );

    Future<void> openSheet(
      WidgetTester t, {
      int protocol = 14,
      String? cap = 'whisper',
      Comment? editing,
    }) async {
      await r.open(
        t,
        hello: {
          'kind': 'hello',
          'protocol': protocol,
          'capabilities': Rig.caps(dictation: cap),
        },
      );
      r.ch.onHttp = (port, method, path) async {
        if (path == '/voice') {
          final id = '${n++}'.padLeft(64, 'a');
          return json(200, {'id': id, 'ms': 2000, 'wave': List.filled(48, 4)});
        }
        await hold?.future;
        if (textStatus != 200) return json(textStatus, null);
        return json(200, {
          'text': 'clip ${path.split('/')[2].replaceAll('a', '')}text',
        });
      };
      got = null;
      unawaited(
        showCommentSheet(
          t.element(find.byType(Composer)),
          quote: 'q',
          editing: editing,
          tab: r.tab,
        ).then((v) => got = v),
      );
      await t.pumpAndSettle();
    }

    Finder mic() => find.descendant(
      of: find.byType(BottomSheet),
      matching: find.byType(RecordButton),
    );

    Future<void> record(WidgetTester t) async {
      final g = await t.startGesture(t.getCenter(mic()));
      await t.pump(const Duration(milliseconds: 700));
      await g.up();
      await t.pump();
      await t.pump();
    }

    Future<void> save(WidgetTester t) async {
      await t.tap(find.widgetWithText(FilledButton, 'Save'));
      await t.pumpAndSettle();
    }

    testWidgets(
      'a released recording becomes a clip under the text; the sheet stays',
      (t) async {
        hold = Completer<void>();
        await openSheet(t);
        await record(t);
        expect(got, isNull);
        expect(find.byType(BottomSheet), findsOneWidget);
        expect(r.ch.requests, ['POST /voice', startsWith('POST /voice/')]);
        expect(r.ch.requests.last, endsWith('/text?lang=en'));
        expect(find.text('Transcribing…'), findsOneWidget);
        // Save waits for the transcript
        expect(
          t.widget<FilledButton>(find.byType(FilledButton)).onPressed,
          isNull,
        );
        hold!.complete();
        await t.pump();
        await t.pump();
        expect(find.text('Transcribing…'), findsNothing);
        expect(find.textContaining('text'), findsWidgets);
        await save(t);
        final res = got as SheetSave;
        expect(res.text, '');
        expect(res.voice, hasLength(1));
        expect(res.voice.single.id, '0'.padLeft(64, 'a'));
        expect(res.voice.single.ms, 2000);
        expect(res.voice.single.text, startsWith('clip'));
      },
    );

    testWidgets('several clips; one is deleted; they keep their order', (
      t,
    ) async {
      await openSheet(t);
      await record(t);
      await record(t);
      await record(t);
      expect(find.byTooltip('Play'), findsNWidgets(3));
      await t.tap(find.byTooltip('Delete').at(1));
      await t.pump();
      expect(find.byTooltip('Play'), findsNWidgets(2));
      await save(t);
      expect((got as SheetSave).voice.map((v) => v.id), [
        '0'.padLeft(64, 'a'),
        '2'.padLeft(64, 'a'),
      ]);
    });

    testWidgets(
      'a clip whose transcription failed shows the reason and Retry; Save waits for it',
      (t) async {
        textStatus = 503;
        await openSheet(t);
        await record(t);
        expect(find.text('Whisper is off on the computer'), findsOneWidget);
        expect(
          t.widget<FilledButton>(find.byType(FilledButton)).onPressed,
          isNull,
        );
        textStatus = 200;
        await t.tap(find.text('Retry'));
        await t.pump();
        await t.pump();
        expect(find.text('Whisper is off on the computer'), findsNothing);
        // the recording is already on the host: only the text is asked again
        expect(r.ch.requests.where((q) => q == 'POST /voice'), hasLength(1));
        await save(t);
        expect((got as SheetSave).voice, hasLength(1));
      },
    );

    testWidgets('a comment with clips opens with them, and gives them back', (
      t,
    ) async {
      final c = Comment(
        id: 'c1',
        anchor: const TextAnchor(
          source: AnchorSourceFile(path: 'a.md'),
          start: 0,
          end: 1,
          quote: 'q',
          prefix: '',
          suffix: '',
        ),
        text: 'typed',
        status: CommentStatus.pending,
        createdAt: 1,
        voice: [
          VoiceClip(
            text: 'said',
            id: 'b' * 64,
            ms: 3000,
            wave: List.filled(48, 2),
          ),
        ],
      );
      await openSheet(t, editing: c);
      expect(find.text('said'), findsOneWidget);
      expect(find.text('0:03'), findsOneWidget);
      await save(t);
      expect((got as SheetSave).voice.single.text, 'said');
      expect(r.ch.requests, isEmpty);
    });

    testWidgets('at ten clips the mic is off', (t) async {
      final c = Comment(
        id: 'c1',
        anchor: const TextAnchor(
          source: AnchorSourceFile(path: 'a.md'),
          start: 0,
          end: 1,
          quote: 'q',
          prefix: '',
          suffix: '',
        ),
        text: '',
        status: CommentStatus.pending,
        createdAt: 1,
        voice: [
          for (var i = 0; i < 10; i++)
            VoiceClip(
              text: 'c$i',
              id: '$i'.padLeft(64, 'b'),
              ms: 1000,
              wave: List.filled(48, 2),
            ),
        ],
      );
      await openSheet(t, editing: c);
      final g = await t.startGesture(t.getCenter(mic()));
      await t.pump(const Duration(milliseconds: 300));
      await g.up();
      expect(rec.calls, isEmpty);
      await t.pump(const Duration(seconds: 3));
    });

    testWidgets(
      'no mic below protocol 14; without Whisper the mic opens its sheet',
      (t) async {
        await openSheet(t, protocol: 13);
        expect(mic(), findsNothing);
      },
    );

    testWidgets('without Whisper the mic opens the install sheet', (t) async {
      await openSheet(t, cap: null);
      await t.tap(mic());
      await t.pumpAndSettle();
      expect(find.text('Dictation by Whisper'), findsOneWidget);
    });

    testWidgets('the record row takes the field while recording', (t) async {
      await openSheet(t);
      final g = await t.startGesture(t.getCenter(mic()));
      await t.pump(const Duration(milliseconds: 300));
      expect(find.byType(RecordRow), findsOneWidget);
      expect(find.text('Slide to cancel'), findsOneWidget);
      await g.moveBy(const Offset(-120, 0));
      await g.up();
      await t.pump();
      expect(rec.calls, ['start', 'cancel']);
      expect(find.byTooltip('Play'), findsNothing);
    });
  });
}
