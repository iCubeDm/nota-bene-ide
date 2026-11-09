import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comment_sheet.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_app/chat/composer.dart';
import 'package:nb_app/dictation/dictation.dart';
import 'package:nb_app/dictation/voice_button.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/theme.dart';

import 'host_dictation_test.dart' show Recorder;
import 'support/fake_dictation.dart';
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
    late FakeDictation phone;
    late Dictation saved;
    setUp(() {
      r = Rig();
      rec = Recorder()..install();
      saved = dictation;
      dictation = phone = FakeDictation();
    });
    tearDown(() {
      dictation = saved;
      r.dispose();
    });

    Future<Finder> openSheet(WidgetTester t, {String? cap}) async {
      await r.open(
        t,
        hello: {
          'kind': 'hello',
          'protocol': 13,
          'capabilities': Rig.caps(dictation: cap),
        },
      );
      showCommentSheet(
        t.element(find.byType(Composer)),
        quote: 'q',
        tab: r.tab,
      );
      await t.pumpAndSettle();
      return find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byType(VoiceButton),
      );
    }

    testWidgets('a whisper-capable tab: the sheet records through the host', (
      t,
    ) async {
      final mic = await openSheet(t, cap: 'whisper');
      final g = await pressVoice(t, at: mic);
      expect(rec.calls, ['start']);
      expect(phone.calls, isEmpty);
      await g.moveBy(const Offset(-120, 0));
      await g.up();
      await t.pump();
    });

    testWidgets('without it: the phone recognizer', (t) async {
      final mic = await openSheet(t);
      final g = await pressVoice(t, at: mic);
      expect(phone.calls, ['listen']);
      expect(rec.calls, isEmpty);
      await g.moveBy(const Offset(-120, 0));
      await g.up();
      await t.pump();
    });

    testWidgets('an error shows inside the sheet', (t) async {
      final mic = await openSheet(t);
      await lockVoice(t, at: mic);
      phone.last.add(const DictationError(DictationFailure.denied));
      phone.last.add(const DictationEnd());
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('Microphone access is off for Nota Bene'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('Save cancels a recording in progress', (t) async {
      final mic = await openSheet(t);
      await lockVoice(t, at: mic);
      await t.tap(find.text('Save'));
      await t.pumpAndSettle();
      expect(phone.calls, ['listen', 'cancel']);
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
