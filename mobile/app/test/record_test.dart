import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/ui/nb_icon.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_app/voice/record_button.dart';
import 'package:nb_app/voice/record_row.dart';
import 'package:nb_app/voice/record_session.dart';
import 'package:nb_app/voice/recorder.dart';

import 'support/voice_fakes.dart';

void main() {
  late RecorderMock rec;
  late Player native;
  late RecordSession session;
  late List<({Uint8List wav, Duration length})> got;
  late List<RecordFailure> errors;
  late List<String> haptics;
  var unavailable = 0;

  setUp(() {
    rec = RecorderMock()..install();
    native = Player()..install();
    VoicePlayer.shared = VoicePlayer(files: MemoryVoiceFiles());
    got = [];
    errors = [];
    haptics = [];
    unavailable = 0;
    session = RecordSession(
      onRecorded: (wav, length) => got.add((wav: wav, length: length)),
      onError: errors.add,
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'HapticFeedback.vibrate') {
            haptics.add(call.arguments as String);
          }
          return null;
        });
  });
  tearDown(() {
    session.dispose();
    rec.uninstall();
    native.uninstall();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Future<void> pump(WidgetTester t, {bool available = true}) => t.pumpWidget(
    NbApp(
      home: Scaffold(
        body: Column(
          children: [
            const Spacer(),
            Row(
              children: [
                Expanded(child: RecordRow(session: session)),
                RecordButton(
                  session: session,
                  available: available,
                  onUnavailable: () => unavailable++,
                ),
              ],
            ),
          ],
        ),
      ),
    ),
  );

  Future<TestGesture> hold(WidgetTester t) async {
    final g = await t.startGesture(t.getCenter(find.byType(RecordButton)));
    await t.pump(const Duration(milliseconds: 200));
    return g;
  }

  testWidgets('hold past 150 ms records with a light haptic; release sends', (
    t,
  ) async {
    await pump(t);
    final g = await t.startGesture(t.getCenter(find.byType(RecordButton)));
    await t.pump(const Duration(milliseconds: 100));
    expect(rec.calls, isEmpty);
    await t.pump(const Duration(milliseconds: 100));
    expect(rec.calls, ['start']);
    expect(haptics, ['HapticFeedbackType.lightImpact']);
    await t.pump(const Duration(milliseconds: 900));
    await g.up();
    await t.pump();
    expect(rec.calls, ['start', 'stop']);
    expect(got, hasLength(1));
    expect(got.single.wav, rec.wav);
    expect(got.single.length, const Duration(seconds: 2));
    expect(session.phase, RecordPhase.idle);
  });

  testWidgets(
    'while it records: the blinking dot, the timer with tenths, Slide to cancel',
    (t) async {
      await pump(t);
      final g = await hold(t);
      expect(find.text('Slide to cancel'), findsOneWidget);
      await t.pump(const Duration(milliseconds: 3200));
      // 200 ms of the hold and 3.2 s more
      expect(find.text('0:03,2'), findsOneWidget);
      await g.up();
      await t.pump();
    },
  );

  testWidgets('the slide label follows the finger and fades', (t) async {
    await pump(t);
    final g = await hold(t);
    final label = find.byKey(const ValueKey('slide'));
    final at = t.getTopLeft(label).dx;
    expect(t.widget<Opacity>(label).opacity, 1);
    await g.moveBy(const Offset(-48, 0));
    await t.pump();
    expect(t.getTopLeft(label).dx, lessThan(at));
    expect(t.widget<Opacity>(label).opacity, closeTo(.5, .05));
    await g.up();
    await t.pump();
  });

  testWidgets('sliding left 96 px cancels with a medium haptic', (t) async {
    await pump(t);
    final g = await hold(t);
    await g.moveBy(const Offset(-100, 0));
    await t.pump();
    expect(rec.calls, ['start', 'cancel']);
    expect(haptics.last, 'HapticFeedbackType.mediumImpact');
    expect(session.phase, RecordPhase.idle);
    await g.up();
    await t.pump();
    expect(got, isEmpty);
    expect(rec.calls, ['start', 'cancel']);
  });

  testWidgets('sliding up 80 px locks; Send then ends it and sends', (t) async {
    await pump(t);
    final g = await hold(t);
    await g.moveBy(const Offset(0, -90));
    await g.up();
    await t.pump();
    expect(session.phase, RecordPhase.locked);
    expect(rec.calls, ['start']);
    expect(find.text('CANCEL'), findsOneWidget);
    expect(find.byTooltip('Stop'), findsOneWidget);
    await t.tap(find.byTooltip('Send'));
    await t.pump();
    expect(rec.calls, ['start', 'stop']);
    expect(got, hasLength(1));
    expect(session.phase, RecordPhase.idle);
  });

  testWidgets('locked: CANCEL drops the recording', (t) async {
    await pump(t);
    final g = await hold(t);
    await g.moveBy(const Offset(0, -90));
    await g.up();
    await t.pump();
    await t.tap(find.text('CANCEL'));
    await t.pump();
    expect(rec.calls, ['start', 'cancel']);
    expect(got, isEmpty);
    expect(session.phase, RecordPhase.idle);
  });

  testWidgets(
    'locked: Stop leads to the preview; Delete drops it, Send sends it',
    (t) async {
      await pump(t);
      var g = await hold(t);
      await g.moveBy(const Offset(0, -90));
      await g.up();
      await t.pump();
      await t.tap(find.byTooltip('Stop'));
      await t.pump();
      expect(session.phase, RecordPhase.preview);
      expect(rec.calls, ['start', 'stop']);
      expect(got, isEmpty);
      expect(find.byTooltip('Delete'), findsOneWidget);
      expect(find.byTooltip('Play'), findsOneWidget);
      expect(find.text('0:02'), findsOneWidget);
      await t.tap(find.byTooltip('Delete'));
      await t.pump();
      expect(session.phase, RecordPhase.idle);
      expect(got, isEmpty);
      // again, and send it
      g = await hold(t);
      await g.moveBy(const Offset(0, -90));
      await g.up();
      await t.pump();
      await t.tap(find.byTooltip('Stop'));
      await t.pump();
      await t.tap(find.byTooltip('Send'));
      await t.pump();
      expect(got, hasLength(1));
      expect(session.phase, RecordPhase.idle);
    },
  );

  testWidgets('the preview plays the recording', (t) async {
    await pump(t);
    final g = await hold(t);
    await g.moveBy(const Offset(0, -90));
    await g.up();
    await t.pump();
    await t.tap(find.byTooltip('Stop'));
    await t.pump();
    await t.tap(find.byTooltip('Play'));
    await t.pump();
    await t.pump();
    expect(native.names, ['play']);
  });

  testWidgets('a short tap shows the hint for 2 s and records nothing', (
    t,
  ) async {
    await pump(t);
    final g = await t.startGesture(t.getCenter(find.byType(RecordButton)));
    await t.pump(const Duration(milliseconds: 80));
    await g.up();
    await t.pump(const Duration(milliseconds: 300));
    expect(find.text('Hold to record, release to send'), findsOneWidget);
    expect(find.byType(SnackBar), findsNothing);
    expect(rec.calls, isEmpty);
    await t.pump(const Duration(seconds: 2));
    expect(find.text('Hold to record, release to send'), findsNothing);
  });

  testWidgets('a recording under half a second is not sent: the hint shows', (
    t,
  ) async {
    rec.wav = wavOf(200);
    await pump(t);
    final g = await hold(t);
    await g.up();
    await t.pump();
    expect(got, isEmpty);
    expect(find.text('Hold to record, release to send'), findsOneWidget);
    await t.pump(const Duration(seconds: 3));
  });

  testWidgets('the recorder reaching its cap sends a held recording', (
    t,
  ) async {
    await pump(t);
    final g = await hold(t);
    await rec.call('capped');
    await t.pump();
    expect(rec.calls, ['start', 'stop']);
    expect(got, hasLength(1));
    await g.up();
    await t.pump();
    expect(got, hasLength(1));
  });

  testWidgets('the cap of a locked recording goes to the preview', (t) async {
    await pump(t);
    final g = await hold(t);
    await g.moveBy(const Offset(0, -90));
    await g.up();
    await t.pump();
    await rec.call('capped');
    await t.pump();
    expect(session.phase, RecordPhase.preview);
    expect(got, isEmpty);
  });

  testWidgets('the timer turns the accent colour from 9:50', (t) async {
    await pump(t);
    final g = await hold(t);
    TextStyle? style() =>
        t.widget<Text>(find.byKey(const ValueKey('timer'))).style;
    final plain = style()?.color;
    session.debugElapsed(const Duration(minutes: 9, seconds: 50));
    await t.pump();
    expect(style()?.color, isNot(plain));
    await g.up();
    await t.pump();
  });

  testWidgets('a denied microphone ends the session with the reason', (
    t,
  ) async {
    rec.startError = 'denied';
    await pump(t);
    final g = await hold(t);
    await g.up();
    await t.pump();
    expect(errors, [RecordFailure.denied]);
    expect(session.phase, RecordPhase.idle);
    expect(got, isEmpty);
  });

  testWidgets('a release before the recorder has started still sends it', (
    t,
  ) async {
    final start = Completer<void>();
    rec.onStart = () => start.future;
    await pump(t);
    final g = await hold(t);
    await g.up();
    await t.pump();
    expect(got, isEmpty);
    start.complete();
    await t.pump(const Duration(milliseconds: 600));
    expect(rec.calls, ['start', 'stop']);
    expect(got, hasLength(1));
  });

  testWidgets(
    'without Whisper a tap or a hold asks for it and records nothing',
    (t) async {
      await pump(t, available: false);
      await t.tap(find.byType(RecordButton));
      await t.pump();
      expect(unavailable, 1);
      final g = await hold(t);
      await g.up();
      expect(rec.calls, isEmpty);
    },
  );

  testWidgets('the recorder failing under a recording ends it', (t) async {
    await pump(t);
    final g = await hold(t);
    await rec.call('failed');
    await t.pump();
    expect(errors, [RecordFailure.failed]);
    expect(rec.calls, ['start', 'cancel']);
    await g.up();
    await t.pump();
    expect(got, isEmpty);
  });

  testWidgets(
    'held: a 96 px circle and the lock float over the button; they go with the finger',
    (t) async {
      await pump(t);
      final circle = find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.constraints?.maxWidth == 96 &&
            w.alignment == Alignment.center,
      );
      final g = await hold(t);
      expect(circle, findsOneWidget);
      expect(t.getSize(circle), const Size(96, 96));
      final lock = find.byWidgetPredicate(
        (w) => w is NbIcon && w.glyph == NbGlyph.lock,
      );
      expect(lock, findsOneWidget);
      final button = t.getCenter(find.byType(RecordButton));
      expect(t.getCenter(circle).dx, closeTo(button.dx, 1));
      await g.up();
      await t.pump();
      expect(circle, findsNothing);
      expect(lock, findsNothing);
    },
  );

  testWidgets(
    'the preview has a fresh uuid key every time, so the player never plays a stale file',
    (t) async {
      await pump(t);
      final keys = <String>[];
      for (var k = 0; k < 2; k++) {
        final g = await hold(t);
        await g.moveBy(const Offset(0, -90));
        await g.up();
        await t.pump();
        await t.tap(find.byTooltip('Stop'));
        await t.pump();
        keys.add(session.previewId);
        await t.tap(find.byTooltip('Delete'));
        await t.pump();
      }
      expect(keys.toSet(), hasLength(2));
      expect(keys.every((k) => RegExp(r'^[0-9a-f-]{36}$').hasMatch(k)), isTrue);
    },
  );

  testWidgets(
    'one recorder: while one session records, another button is off',
    (t) async {
      final other = RecordSession(
        onRecorded: (w, l) => got.add((wav: w, length: l)),
      );
      addTearDown(other.dispose);
      await t.pumpWidget(
        NbApp(
          home: Scaffold(
            body: Row(
              children: [
                RecordButton(session: session),
                const SizedBox(width: 100),
                RecordButton(key: const ValueKey('other'), session: other),
              ],
            ),
          ),
        ),
      );
      final g = await t.startGesture(
        t.getCenter(find.byType(RecordButton).first),
      );
      await t.pump(const Duration(milliseconds: 300));
      final h = await t.startGesture(
        t.getCenter(find.byKey(const ValueKey('other'))),
      );
      await t.pump(const Duration(milliseconds: 300));
      expect(rec.calls, ['start']);
      expect(other.phase, RecordPhase.idle);
      await h.up();
      await g.up();
      await t.pump();
      await t.pump(const Duration(seconds: 3));
      // the microphone is free again
      final k = await t.startGesture(
        t.getCenter(find.byKey(const ValueKey('other'))),
      );
      await t.pump(const Duration(milliseconds: 300));
      expect(other.phase, RecordPhase.recording);
      await k.up();
      await t.pump();
      await t.pump(const Duration(seconds: 3));
    },
  );

  testWidgets('the preview wave is drawn once, not on every rebuild', (
    t,
  ) async {
    await pump(t);
    final g = await hold(t);
    await g.moveBy(const Offset(0, -90));
    await g.up();
    await t.pump();
    await t.tap(find.byTooltip('Stop'));
    await t.pump();
    final wave = session.wave;
    expect(wave, hasLength(48));
    session.debugElapsed(Duration.zero);
    await t.pump();
    expect(identical(session.wave, wave), isTrue);
  });

  testWidgets('TalkBack: a tap on the semantic mic starts a locked recording', (
    t,
  ) async {
    final h = t.ensureSemantics();
    await pump(t);
    t.semantics.tap(find.semantics.byLabel('Hold to record'));
    await t.pump(const Duration(milliseconds: 100));
    expect(session.phase, RecordPhase.locked);
    expect(rec.calls, ['start']);
    session.cancel();
    h.dispose();
    await t.pump();
  });

  testWidgets(
    'the lock pill is 40 wide, just above the circle; Stop is 40x40',
    (t) async {
      await pump(t);
      final g = await hold(t);
      // read while held: the recording row lays the button out a little differently
      final mic = t.getCenter(find.byType(RecordButton));
      final pill = find.byWidgetPredicate(
        (w) => w is NbIcon && w.glyph == NbGlyph.lock,
      );
      final box = find
          .ancestor(of: pill, matching: find.byType(Container))
          .first;
      expect(t.getSize(box).width, 40);
      expect(t.getSize(box).height, 76);
      // above the 96 px circle, centred on the mic
      expect(t.getBottomLeft(box).dy, closeTo(mic.dy - 48 - 12, 1));
      expect(t.getCenter(box).dx, closeTo(mic.dx, 1));
      await g.moveBy(const Offset(0, -90));
      await g.up();
      await t.pump();
      final stop = find.byKey(const ValueKey('voice-stop'));
      expect(t.getSize(stop), const Size(40, 40));
      // 8 px above the 48 px button
      expect(t.getBottomLeft(stop).dy, closeTo(mic.dy - 24 - 8, 1));
      expect(t.getCenter(stop).dx, closeTo(mic.dx, 1));
      session.cancel();
      await t.pump();
    },
  );
}
