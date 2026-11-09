import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/dictation/dictation.dart';
import 'package:nb_app/dictation/record_bar.dart';
import 'package:nb_app/dictation/voice_button.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/theme.dart';

import 'support/fake_dictation.dart';

void main() {
  late FakeDictation fake;
  late Dictation saved;
  late List<VoiceState> states;
  late List<String> haptics;
  setUp(() {
    saved = dictation;
    dictation = fake = FakeDictation();
    states = [];
    haptics = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'HapticFeedback.vibrate') {
            haptics.add(call.arguments as String);
          }
          return null;
        });
  });
  tearDown(() {
    dictation = saved;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Future<TextEditingController> pump(
    WidgetTester t, {
    String text = '',
    bool show = true,
    ValueNotifier<bool>? enabled,
  }) async {
    final c = TextEditingController(text: text);
    c.selection = TextSelection.collapsed(offset: text.length);
    final meter = VoiceMeter();
    await t.pumpWidget(
      NbApp(
        home: Scaffold(
          body: show
              ? ValueListenableBuilder<bool>(
                  valueListenable: enabled ?? ValueNotifier(true),
                  builder: (_, on, _) => Row(
                    children: [
                      Expanded(child: TextField(controller: c)),
                      VoiceButton(
                        controller: c,
                        enabled: on,
                        meter: meter,
                        onState: states.add,
                      ),
                    ],
                  ),
                )
              : const SizedBox(),
        ),
      ),
    );
    return c;
  }

  testWidgets('hold then release: listen, stop, the final text lands', (
    t,
  ) async {
    final c = await pump(t, text: 'Fix ');
    final g = await pressVoice(t);
    expect(fake.calls, ['listen']);
    fake.last.add(const DictationPartial('the head'));
    await t.pump();
    expect(c.text, 'Fix the head');
    await g.up();
    await t.pump();
    expect(fake.calls, ['listen', 'stop']);
    fake.last.add(const DictationFinal('the header'));
    fake.last.add(const DictationEnd());
    await t.pump();
    expect(c.text, 'Fix the header');
    expect(c.selection.baseOffset, 'Fix the header'.length);
  });

  testWidgets('onState goes idle, recording, working, idle', (t) async {
    await pump(t);
    final g = await pressVoice(t);
    await g.up();
    await t.pump();
    fake.last.add(const DictationFinal('x'));
    fake.last.add(const DictationEnd());
    await t.pump();
    expect(states, [VoiceState.recording, VoiceState.working, VoiceState.idle]);
  });

  testWidgets('a short tap shows the hint and starts nothing', (t) async {
    await pump(t);
    final g = await t.startGesture(t.getCenter(find.byType(VoiceButton)));
    await t.pump(const Duration(milliseconds: 100));
    await g.up();
    await t.pump();
    expect(find.text('Hold to record'), findsOneWidget);
    expect(fake.calls, isEmpty);
    expect(states, isEmpty);
  });

  testWidgets('sliding left 120 px cancels and leaves the field as it was', (
    t,
  ) async {
    final c = await pump(t, text: 'Fix ');
    final g = await pressVoice(t);
    fake.last.add(const DictationPartial('abc'));
    await t.pump();
    expect(c.text, 'Fix abc');
    await g.moveBy(const Offset(-120, 0));
    await t.pump();
    expect(fake.calls, ['listen', 'cancel']);
    expect(c.text, 'Fix ');
    expect(haptics, isNotEmpty);
    await g.up();
    await t.pump();
    expect(fake.calls, ['listen', 'cancel']);
    expect(states.last, VoiceState.idle);
  });

  testWidgets('sliding left less than the threshold does not cancel', (
    t,
  ) async {
    await pump(t);
    final g = await pressVoice(t);
    await g.moveBy(const Offset(-60, 0));
    await t.pump();
    expect(fake.calls, ['listen']);
    await g.up();
    await t.pump();
  });

  testWidgets('sliding up locks: release keeps recording, stop ends it', (
    t,
  ) async {
    await pump(t);
    final g = await pressVoice(t);
    await g.moveBy(const Offset(0, -100));
    await g.up();
    await t.pump();
    expect(fake.calls, ['listen']);
    expect(states, [VoiceState.recording, VoiceState.locked]);
    expect(haptics, isNotEmpty);
    VoiceButton.stopRunning();
    await t.pump();
    expect(fake.calls, ['listen', 'stop']);
    expect(states.last, VoiceState.working);
  });

  testWidgets('locked: cancel cancels and restores the field', (t) async {
    final c = await pump(t, text: 'Fix ');
    await lockVoice(t);
    fake.last.add(const DictationPartial('abc'));
    await t.pump();
    VoiceButton.cancelRunning();
    await t.pump();
    expect(fake.calls, ['listen', 'cancel']);
    expect(c.text, 'Fix ');
    expect(states.last, VoiceState.idle);
  });

  testWidgets('hiding the app while locked cancels', (t) async {
    await pump(t);
    await lockVoice(t);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await t.pump();
    expect(fake.calls, ['listen', 'cancel']);
    expect(states.last, VoiceState.idle);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });

  testWidgets('typing while the host transcribes: the words still land where '
      'the recording began', (t) async {
    final c = await pump(t, text: 'Fix ');
    await holdVoice(t);
    c.value = const TextEditingValue(
      text: 'Fix later',
      selection: TextSelection.collapsed(offset: 9),
    );
    fake.last.add(const DictationFinal('words'));
    fake.last.add(const DictationEnd());
    await t.pump();
    expect(c.text, 'Fix words later');
    expect(c.selection.baseOffset, 'Fix words later'.length);
  });

  testWidgets('a space separates words from text on both sides', (t) async {
    final c = await pump(t, text: 'Fix theheader');
    c.selection = const TextSelection.collapsed(offset: 7);
    await holdVoice(t);
    fake.last.add(const DictationFinal('words'));
    await t.pump();
    expect(c.text, 'Fix the words header');
  });

  testWidgets('an error restores the field and says so', (t) async {
    final c = await pump(t, text: 'Fix ');
    final g = await pressVoice(t);
    fake.last.add(const DictationPartial('abc'));
    fake.last.add(const DictationError(DictationFailure.denied));
    fake.last.add(const DictationEnd());
    await t.pump();
    await g.up();
    await t.pump();
    expect(find.text('Microphone access is off for Nota Bene'), findsOneWidget);
    expect(c.text, 'Fix ');
  });

  testWidgets('leaving while recording cancels', (t) async {
    await pump(t);
    await pressVoice(t);
    await t.pumpWidget(const SizedBox());
    expect(fake.calls, ['listen', 'cancel']);
  });

  testWidgets('disabled does nothing', (t) async {
    await pump(t, enabled: ValueNotifier(false));
    await holdVoice(t);
    expect(fake.calls, isEmpty);
  });

  testWidgets('starting one cancels another', (t) async {
    final a = TextEditingController();
    final b = TextEditingController();
    await t.pumpWidget(
      NbApp(
        home: Scaffold(
          body: Column(
            children: [
              VoiceButton(key: const Key('a'), controller: a),
              VoiceButton(key: const Key('b'), controller: b),
            ],
          ),
        ),
      ),
    );
    await lockVoice(t, at: find.byKey(const Key('a')));
    await pressVoice(t, at: find.byKey(const Key('b')));
    expect(fake.calls, ['listen', 'cancel', 'listen']);
  });

  testWidgets('levels reach the meter and the timer counts', (t) async {
    final meter = VoiceMeter();
    final c = TextEditingController();
    await t.pumpWidget(
      NbApp(
        home: Scaffold(
          body: VoiceButton(controller: c, meter: meter),
        ),
      ),
    );
    await lockVoice(t);
    fake.last.add(const DictationLevel(.5));
    await t.pump();
    expect(meter.levels.last, .5);
    await t.pump(const Duration(seconds: 3));
    expect(meter.elapsed.inSeconds, greaterThanOrEqualTo(3));
    VoiceButton.cancelRunning();
    await t.pump();
  });

  testWidgets('an empty final keeps the last partial', (t) async {
    final c = await pump(t, text: 'Fix ');
    await lockVoice(t);
    fake.last.add(const DictationPartial('the header'));
    fake.last.add(const DictationFinal(''));
    fake.last.add(const DictationEnd());
    await t.pump();
    expect(c.text, 'Fix the header');
  });

  testWidgets('a failure restores the field and its selection', (t) async {
    final c = await pump(t, text: 'Fix header');
    c.selection = const TextSelection(baseOffset: 4, extentOffset: 10);
    await lockVoice(t);
    fake.last.add(const DictationPartial('title'));
    await t.pump();
    expect(c.text, 'Fix title');
    fake.last.add(const DictationError(DictationFailure.denied));
    fake.last.add(const DictationEnd());
    await t.pump();
    expect(c.text, 'Fix header');
    expect(c.selection, const TextSelection(baseOffset: 4, extentOffset: 10));
  });

  testWidgets('typing while recording is kept and ends the dictation', (
    t,
  ) async {
    final c = await pump(t, text: 'Fix ');
    await lockVoice(t);
    fake.last.add(const DictationPartial('the'));
    await t.pump();
    c.value = const TextEditingValue(
      text: 'Fix the big',
      selection: TextSelection.collapsed(offset: 11),
    );
    fake.last.add(const DictationFinal('the header'));
    await t.pump();
    expect(c.text, 'Fix the big');
    expect(fake.calls, ['listen', 'cancel']);
  });

  testWidgets('disabling while recording cancels', (t) async {
    final on = ValueNotifier(true);
    await pump(t, enabled: on);
    await lockVoice(t);
    on.value = false;
    await t.pump();
    expect(fake.calls, ['listen', 'cancel']);
    expect(states.last, VoiceState.idle);
  });

  testWidgets('the language tag follows the UI, not the device', (t) async {
    t.platformDispatcher.localesTestValue = const [Locale('ja', 'JP')];
    addTearDown(t.platformDispatcher.clearLocalesTestValue);
    await pump(t);
    await lockVoice(t);
    expect(fake.tags, ['en']);
    VoiceButton.cancelRunning();
  });

  testWidgets('a failing stop is not an unhandled error', (t) async {
    dictation = ThrowingDictation();
    await pump(t);
    await holdVoice(t);
    await t.pumpWidget(const SizedBox());
    expect(t.takeException(), isNull);
  });

  testWidgets('a second stop does nothing', (t) async {
    await pump(t);
    await lockVoice(t);
    VoiceButton.stopRunning();
    VoiceButton.stopRunning();
    expect(fake.calls, ['listen', 'stop']);
  });

  group('RecordBar', () {
    Future<void> bar(WidgetTester t, VoiceState s, VoiceMeter m) =>
        t.pumpWidget(
          NbApp(
            home: Scaffold(
              body: RecordBar(state: s, meter: m),
            ),
          ),
        );

    testWidgets('holding shows the timer and the slide hint', (t) async {
      final m = VoiceMeter()..elapsed = const Duration(seconds: 65);
      await bar(t, VoiceState.recording, m);
      expect(find.text('1:05'), findsOneWidget);
      expect(find.text('◀ Slide to cancel'), findsOneWidget);
    });

    testWidgets('locked shows Cancel and Stop', (t) async {
      await bar(t, VoiceState.locked, VoiceMeter());
      expect(find.text('Cancel'), findsOneWidget);
      expect(find.byTooltip('Stop'), findsOneWidget);
    });

    testWidgets('working says Transcribing…', (t) async {
      await bar(t, VoiceState.working, VoiceMeter());
      expect(find.text('Transcribing…'), findsOneWidget);
    });

    testWidgets('the timer turns accent from 110 s', (t) async {
      Color? colorOf() =>
          t.widget<Text>(find.byKey(const Key('timer'))).style?.color;
      await bar(
        t,
        VoiceState.recording,
        VoiceMeter()..elapsed = const Duration(seconds: 109),
      );
      final accent = Theme.of(
        t.element(find.byType(RecordBar)),
      ).extension<NbColors>()!.accent;
      expect(colorOf(), isNot(accent));
      await bar(
        t,
        VoiceState.recording,
        VoiceMeter()..elapsed = const Duration(seconds: 110),
      );
      expect(colorOf(), accent);
    });
  });
}
