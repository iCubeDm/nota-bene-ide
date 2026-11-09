import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comment_sheet.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_app/chat/composer.dart';
import 'package:nb_channel/nb_channel.dart';
import 'package:nb_app/dictation/voice_button.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/theme.dart';

import 'host_dictation_test.dart' show Recorder, answer;
import 'support/fake_dictation.dart' show holdVoice, lockVoice, pressVoice;
import 'support/rig.dart';

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

  group('voice', () {
    late Rig r;
    late Recorder rec;
    late Completer<HttpAnswer> reply;
    setUp(() {
      r = Rig();
      rec = Recorder()..install();
    });
    tearDown(() {
      rec.uninstall();
      r.dispose();
    });

    Future<Finder> openSheet(WidgetTester t, {String? cap = 'whisper'}) async {
      await r.open(
        t,
        hello: {
          'kind': 'hello',
          'protocol': 13,
          'capabilities': Rig.caps(dictation: cap),
        },
      );
      reply = Completer<HttpAnswer>();
      r.ch.onHttp = (port, method, path) => reply.future;
      got = null;
      unawaited(
        showCommentSheet(
          t.element(find.byType(Composer)),
          quote: 'q',
          tab: r.tab,
        ).then((v) => got = v),
      );
      await t.pumpAndSettle();
      return find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byType(VoiceButton),
      );
    }

    testWidgets('the sheet records through the host', (t) async {
      final mic = await openSheet(t);
      final g = await pressVoice(t, at: mic);
      expect(rec.calls, ['start']);
      await g.moveBy(const Offset(-120, 0));
      await g.up();
      await t.pump();
    });

    testWidgets("without Whisper the sheet's mic offers it", (t) async {
      final mic = await openSheet(t, cap: null);
      r.ch.onHttp = (port, method, path) async => answer(
        200,
        '{"on":false,"phase":"none","downloadMb":1,"diskMb":2,"dir":"/w"}',
      );
      await holdVoice(t, at: mic);
      await t.pumpAndSettle();
      expect(rec.calls, isEmpty);
      expect(find.text('Install'), findsOneWidget);
    });

    testWidgets('an error shows inside the sheet', (t) async {
      final mic = await openSheet(t);
      await lockVoice(t, at: mic);
      VoiceButton.stopRunning();
      reply.complete(answer(500));
      await t.pump();
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('The computer could not transcribe it'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('Save stops a locked recording and stores its text', (t) async {
      final mic = await openSheet(t);
      await lockVoice(t, at: mic);
      await t.tap(find.text('Save'));
      await t.pump();
      expect(rec.calls, ['start', 'stop']);
      reply.complete(answer(200, '{"text":"the header"}'));
      await t.pumpAndSettle();
      expect((got as SheetSave).text, 'the header');
    });

    testWidgets('the sheet shows the record bar while it records', (t) async {
      final mic = await openSheet(t);
      await lockVoice(t, at: mic);
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('Cancel'),
        ),
        findsNWidgets(2),
      );
      VoiceButton.cancelRunning();
      await t.pump();
    });
  });
}
