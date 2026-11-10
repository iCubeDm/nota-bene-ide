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
import 'package:nb_app/store/vault.dart';
import 'package:nb_app/store/voice_lang.dart';
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

  final sendKey = find.descendant(
    of: find.byType(BottomSheet),
    matching: find.byKey(const ValueKey('send')),
  );
  final field = find.descendant(
    of: find.byType(BottomSheet),
    matching: find.byType(TextField),
  );
  final handle = find.byKey(const ValueKey('sheet-handle'));

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
    final accent = Theme.of(t.element(field)).extension<NbColors>()!.accent;
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
    await t.enterText(field, 'because');
    await t.pumpAndSettle();
    await t.tap(sendKey);
    await t.pumpAndSettle();
    final r = got as SheetSave;
    expect((r.label, r.text), (l.id, 'because'));
  });

  testWidgets('there are no Save and Cancel buttons: the field has Send', (
    t,
  ) async {
    await open(t);
    expect(find.text('Save'), findsNothing);
    expect(find.text('Cancel'), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    expect(sendKey, findsOneWidget);
    // nothing to send yet
    expect(t.widget<IconButton>(sendKey).onPressed, isNull);
  });

  testWidgets('Send follows the text', (t) async {
    await open(t);
    expect(t.widget<IconButton>(sendKey).onPressed, isNull);
    await t.enterText(field, 'x');
    await t.pumpAndSettle();
    expect(t.widget<IconButton>(sendKey).onPressed, isNotNull);
  });

  testWidgets('the sheet has no paperclip', (t) async {
    await open(t);
    expect(find.byKey(const ValueKey('attach')), findsNothing);
  });

  testWidgets('a label alone can be sent', (t) async {
    await open(t);
    final l = quickLabels[0];
    await t.tap(circle(l));
    await t.pumpAndSettle();
    await t.tap(sendKey);
    await t.pumpAndSettle();
    final r = got as SheetSave;
    expect((r.label, r.text, r.voice.length), (l.id, '', 0));
  });

  testWidgets('back with nothing typed closes without asking', (t) async {
    await open(t);
    await t.tap(circle(quickLabels[0]));
    await t.pump();
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    expect(got, isNull);
  });

  testWidgets('back with a typed draft asks; Keep writing keeps it', (t) async {
    await open(t);
    await t.enterText(field, 'draft');
    await t.pumpAndSettle();
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    expect(find.text('Discard the comment?'), findsOneWidget);
    await t.tap(find.text('Keep writing'));
    await t.pumpAndSettle();
    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.text('draft'), findsOneWidget);
  });

  testWidgets('back with a typed draft and Discard closes the sheet', (
    t,
  ) async {
    await open(t);
    await t.enterText(field, 'draft');
    await t.pumpAndSettle();
    await t.binding.handlePopRoute();
    await t.pumpAndSettle();
    await t.tap(find.text('Discard'));
    await t.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    expect(got, isNull);
  });

  testWidgets('a swipe down on the handle closes; with a draft it asks', (
    t,
  ) async {
    await open(t);
    await t.fling(handle, const Offset(0, 300), 1500);
    await t.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    await open(t);
    await t.enterText(field, 'draft');
    await t.pumpAndSettle();
    await t.fling(handle, const Offset(0, 300), 1500);
    await t.pumpAndSettle();
    expect(find.text('Discard the comment?'), findsOneWidget);
    expect(find.byType(BottomSheet), findsOneWidget);
  });

  testWidgets(
    'the handle follows the finger and springs back when released short',
    (t) async {
      await open(t);
      final top = t.getTopLeft(find.text('a quote')).dy;
      final g = await t.startGesture(t.getCenter(handle));
      await g.moveBy(const Offset(0, 40));
      await t.pump();
      expect(t.getTopLeft(find.text('a quote')).dy, greaterThan(top + 20));
      await g.up();
      await t.pumpAndSettle();
      expect(t.getTopLeft(find.text('a quote')).dy, top);
      expect(find.byType(BottomSheet), findsOneWidget);
    },
  );

  testWidgets('the handle is a dismiss button for TalkBack', (t) async {
    await open(t);
    final h = t.getSemantics(handle);
    expect(h.label, 'Dismiss');
  });

  testWidgets('tapping the selected emoji clears the label', (t) async {
    await open(t);
    final l = quickLabels[1];
    await t.tap(circle(l));
    await t.tap(circle(l));
    await t.enterText(field, 'x');
    await t.pumpAndSettle();
    await t.tap(sendKey);
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

    Future<void> send(WidgetTester t) async {
      await t.tap(sendKey);
      await t.pumpAndSettle();
    }

    Comment commentWith(int clips, {String text = 'typed'}) => Comment(
      id: 'c1',
      anchor: const TextAnchor(
        source: AnchorSourceFile(path: 'a.md'),
        start: 0,
        end: 1,
        quote: 'q',
        prefix: '',
        suffix: '',
      ),
      text: text,
      status: CommentStatus.pending,
      createdAt: 1,
      voice: [
        for (var i = 0; i < clips; i++)
          VoiceClip(
            text: 'said$i',
            id: '$i'.padLeft(64, 'b'),
            ms: 3000,
            wave: List.filled(48, 2),
          ),
      ],
    );

    testWidgets('a clip is transcribed in the voice language of Settings', (
      t,
    ) async {
      final v = await VoiceLang.load(MemoryVault());
      await v.choose('ru');
      r.voiceLang = v;
      await openSheet(t);
      await record(t);
      await t.pumpAndSettle();
      expect(r.ch.requests.last, endsWith('/text?lang=ru'));
    });

    testWidgets(
      'a released recording saves the comment with that clip once its text is in',
      (t) async {
        hold = Completer<void>();
        await openSheet(t);
        await record(t);
        expect(r.ch.requests, ['POST /voice', startsWith('POST /voice/')]);
        expect(r.ch.requests.last, endsWith('/text?lang=en'));
        // the transcript is part of the comment: the sheet waits for it
        expect(got, isNull);
        expect(find.byType(BottomSheet), findsOneWidget);
        expect(find.text('Transcribing…'), findsOneWidget);
        hold!.complete();
        await t.pump();
        await t.pump();
        await t.pumpAndSettle();
        expect(find.byType(BottomSheet), findsNothing);
        final res = got as SheetSave;
        expect(res.text, '');
        expect(res.voice, hasLength(1));
        expect(res.voice.single.id, '0'.padLeft(64, 'a'));
        expect(res.voice.single.ms, 2000);
        expect(res.voice.single.text, startsWith('clip'));
      },
    );

    testWidgets(
      'a chosen label goes with the voice; Send and the mic are both there',
      (t) async {
        await openSheet(t);
        // nothing chosen: the mic alone
        expect(mic(), findsOneWidget);
        expect(sendKey, findsNothing);
        final l = quickLabels[3];
        await t.tap(find.byKey(ValueKey('label:${l.id.name}')));
        await t.pumpAndSettle();
        expect(mic(), findsOneWidget);
        expect(sendKey, findsOneWidget);
        await record(t);
        await t.pumpAndSettle();
        final res = got as SheetSave;
        expect((res.label, res.text, res.voice.length), (l.id, '', 1));
      },
    );

    testWidgets('typing turns the mic into Send', (t) async {
      await openSheet(t);
      await t.enterText(field, 'words');
      await t.pumpAndSettle();
      expect(mic(), findsNothing);
      expect(sendKey, findsOneWidget);
      await send(t);
      expect((got as SheetSave).text, 'words');
    });

    testWidgets('a label with typed text sends without a mic', (t) async {
      await openSheet(t);
      await t.tap(find.byKey(ValueKey('label:${quickLabels[0].id.name}')));
      await t.enterText(field, 'words');
      await t.pumpAndSettle();
      expect(mic(), findsNothing);
    });

    testWidgets(
      'a clip whose transcription failed stays with the reason and Retry; a retry saves',
      (t) async {
        textStatus = 503;
        await openSheet(t);
        await record(t);
        expect(find.text('Whisper is off on the computer'), findsOneWidget);
        expect(got, isNull);
        textStatus = 200;
        await t.tap(find.text('Retry'));
        await t.pump();
        await t.pump();
        await t.pumpAndSettle();
        // the recording is already on the host: only the text is asked again
        expect(r.ch.requests.where((q) => q == 'POST /voice'), hasLength(1));
        expect((got as SheetSave).voice, hasLength(1));
      },
    );

    testWidgets('a Retry asks in the language the clip was recorded in', (
      t,
    ) async {
      final v = await VoiceLang.load(MemoryVault());
      await v.choose('ru');
      r.voiceLang = v;
      textStatus = 503;
      await openSheet(t);
      await record(t);
      await v.choose('en');
      textStatus = 200;
      await t.tap(find.text('Retry'));
      await t.pump();
      await t.pump();
      expect(r.ch.requests.last, endsWith('/text?lang=ru'));
    });

    testWidgets(
      'a comment with clips opens with them, and Send gives them back',
      (t) async {
        await openSheet(t, editing: commentWith(1));
        expect(find.text('said0'), findsOneWidget);
        expect(find.text('0:03'), findsOneWidget);
        await send(t);
        expect((got as SheetSave).voice.single.text, 'said0');
        expect(r.ch.requests, isEmpty);
      },
    );

    testWidgets('an existing clip can be removed before Send', (t) async {
      await openSheet(t, editing: commentWith(2));
      await t.tap(find.byTooltip('Delete').first);
      await t.pump();
      await send(t);
      expect((got as SheetSave).voice.map((v) => v.text), ['said1']);
    });

    testWidgets('a recording in an edit joins the clips the comment has', (
      t,
    ) async {
      await openSheet(t, editing: commentWith(1, text: ''));
      await record(t);
      await t.pumpAndSettle();
      final v = (got as SheetSave).voice;
      expect(v, hasLength(2));
      expect(v.first.text, 'said0');
    });

    testWidgets('closing an edit that changed nothing does not ask', (t) async {
      await openSheet(t, editing: commentWith(1));
      await t.binding.handlePopRoute();
      await t.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
    });

    testWidgets('removing a clip is a change to ask about', (t) async {
      await openSheet(t, editing: commentWith(1));
      await t.tap(find.byTooltip('Delete').first);
      await t.pump();
      await t.binding.handlePopRoute();
      await t.pumpAndSettle();
      expect(find.text('Discard the comment?'), findsOneWidget);
    });

    testWidgets('at ten clips the mic is off', (t) async {
      await openSheet(t, editing: commentWith(10, text: ''));
      final g = await t.startGesture(t.getCenter(mic()));
      await t.pump(const Duration(milliseconds: 300));
      await g.up();
      expect(rec.calls, isEmpty);
      await t.pump(const Duration(seconds: 3));
    });

    testWidgets('below protocol 14 the mic is greyed and says why', (t) async {
      await openSheet(t, protocol: 13);
      expect(mic(), findsNothing);
      final old = find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byKey(const ValueKey('mic-old')),
      );
      expect(old, findsOneWidget);
      await t.tap(old);
      await t.pump();
      expect(
        find.text('Voice messages need a newer Nota Bene on the computer.'),
        findsOneWidget,
      );
    });

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
      expect(find.byType(RecordRow), findsNothing);
    });

    testWidgets(
      'a locked recording, back, Delete closes without a second question',
      (t) async {
        await openSheet(t);
        final g = await t.startGesture(t.getCenter(mic()));
        await t.pump(const Duration(milliseconds: 300));
        await g.moveBy(const Offset(0, -120));
        await t.pump();
        await g.up();
        await t.pump();
        await t.binding.handlePopRoute();
        await t.pumpAndSettle();
        expect(find.text('Send the voice message?'), findsOneWidget);
        await t.tap(find.text('Delete'));
        await t.pumpAndSettle();
        expect(find.text('Discard the comment?'), findsNothing);
        expect(find.byType(BottomSheet), findsNothing);
        expect(got, isNull);
      },
    );

    testWidgets(
      'the mic does not move when a recording starts with a label chosen',
      (t) async {
        await openSheet(t);
        await t.tap(find.byKey(ValueKey('label:${quickLabels[0].id.name}')));
        await t.pumpAndSettle();
        final before = t.getCenter(mic());
        final g = await t.startGesture(before);
        await t.pump(const Duration(milliseconds: 300));
        await t.pump(const Duration(milliseconds: 300));
        expect(find.byType(RecordRow), findsOneWidget);
        expect(t.getCenter(mic()), before);
        await g.moveBy(const Offset(-120, 0));
        await g.up();
        await t.pump();
      },
    );

    testWidgets('the greyed mic says why above the field, not over it', (
      t,
    ) async {
      await openSheet(t, protocol: 13);
      await t.tap(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.byKey(const ValueKey('mic-old')),
        ),
      );
      await t.pump();
      await t.pump(const Duration(milliseconds: 1000));
      expect(
        t
            .getRect(
              find.text(
                'Voice messages need a newer Nota Bene on the computer.',
              ),
            )
            .bottom,
        lessThanOrEqualTo(t.getRect(field).top),
      );
    });

    testWidgets(
      'after a failed transcript the mic is off: one voice per comment',
      (t) async {
        textStatus = 503;
        await openSheet(t);
        await record(t);
        expect(find.text('Retry'), findsOneWidget);
        await t.pumpAndSettle();
        rec.calls.clear();
        final g = await t.startGesture(t.getCenter(mic()));
        await t.pump(const Duration(milliseconds: 300));
        await g.up();
        expect(rec.calls, isEmpty);
      },
    );

    testWidgets('changing the label of an edit is a change to ask about', (
      t,
    ) async {
      await openSheet(t, editing: commentWith(0));
      await t.tap(circle(quickLabels[0]));
      await t.pump();
      await t.binding.handlePopRoute();
      await t.pumpAndSettle();
      expect(find.text('Discard the comment?'), findsOneWidget);
    });

    testWidgets('several existing clips keep their order when one is removed', (
      t,
    ) async {
      await openSheet(t, editing: commentWith(3));
      await t.tap(find.byTooltip('Delete').at(1));
      await t.pump();
      await send(t);
      expect((got as SheetSave).voice.map((v) => v.text), ['said0', 'said2']);
    });
  });
}
