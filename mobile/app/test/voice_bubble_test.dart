import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_app/store/voice_lang.dart';
import 'package:nb_app/voice/player.dart';

import 'support/rig.dart';
import 'support/voice_fakes.dart';

void main() {
  late Rig r;
  late Player native;
  final voice = {'id': 'c' * 64, 'ms': 12000, 'wave': List.filled(48, 9)};
  Map<String, Object?> user(String id, {String text = '', Object? v}) => {
    'kind': 'user',
    'id': id,
    'text': text,
    'voice': v ?? voice,
    'ts': 1,
    'historic': true,
  };

  setUp(() {
    r = Rig();
    native = Player()..install();
    VoicePlayer.shared = VoicePlayer(files: MemoryVoiceFiles());
  });
  tearDown(() {
    native.uninstall();
    r.dispose();
  });

  testWidgets(
    'a voice bubble: play, the length, Transcribing… and then the text',
    (t) async {
      await r.open(t, events: [user('u1')], settle: false);
      expect(find.byTooltip('Play'), findsOneWidget);
      expect(find.text('0:12'), findsOneWidget);
      expect(find.text('Transcribing…'), findsOneWidget);
      r.event({
        'kind': 'voice-text',
        'id': 'u1',
        'text': 'fix the header',
        'ts': 2,
      });
      await t.pump();
      expect(find.text('Transcribing…'), findsNothing);
      expect(find.text('fix the header'), findsOneWidget);
    },
  );

  testWidgets('Aa folds the transcript and opens it again', (t) async {
    await r.open(t, events: [user('u1', text: 'fix the header')]);
    expect(find.text('fix the header'), findsOneWidget);
    await t.tap(find.byKey(const ValueKey('fold')));
    await t.pump();
    expect(find.text('fix the header'), findsNothing);
    await t.tap(find.byKey(const ValueKey('fold')));
    await t.pump();
    expect(find.text('fix the header'), findsOneWidget);
  });

  testWidgets(
    'a failure shows its reason; Retry sends the voice again as a new message',
    (t) async {
      await r.open(t, events: [user('u1')], settle: false);
      r.event({'kind': 'voice-text', 'id': 'u1', 'error': 'off', 'ts': 2});
      await t.pump();
      expect(find.text('Whisper is off on the computer'), findsOneWidget);
      await t.tap(find.text('Retry'));
      await t.pump();
      final m = r.sent.single;
      expect(m['type'], 'send');
      expect(m['id'], isNot('u1'));
      expect(m['text'], '');
      expect(m['voice'], voice);
      expect(m['lang'], 'en');
      expect(m.containsKey('force'), isFalse);
      expect(m.containsKey('images'), isFalse);
      // the retry's message arrives: the failed bubble goes
      r.event({...user(m['id']! as String), 'historic': null});
      await t.pump();
      expect(find.text('Retry'), findsNothing);
      expect(find.byTooltip('Play'), findsOneWidget);
    },
  );

  testWidgets('the other reasons', (t) async {
    await r.open(
      t,
      events: [
        user('u1'),
        user('u2', v: {...voice, 'id': 'd' * 64}),
      ],
      settle: false,
    );
    r.event({'kind': 'voice-text', 'id': 'u1', 'error': 'empty', 'ts': 2});
    r.event({'kind': 'voice-text', 'id': 'u2', 'error': 'failed', 'ts': 2});
    await t.pump();
    expect(find.text('Nothing was recognised'), findsOneWidget);
    expect(find.text('Could not transcribe'), findsOneWidget);
  });

  testWidgets('play fetches the voice from the window and plays it', (t) async {
    await r.open(t, events: [user('u1', text: 'x')]);
    r.ch.onHttp = (port, method, path) async => (
      status: 200,
      headers: const <String, String>{},
      body: Uint8List.fromList([1, 2, 3]),
    );
    await t.tap(find.byTooltip('Play'));
    await t.pump();
    await t.pump();
    expect(r.ch.requests, ['GET /voice/${'c' * 64}']);
    expect(native.names, ['play']);
    expect(
      (native.calls.single.arguments as Map)['path'],
      '/cache/voice/${'c' * 64}.wav',
    );
  });

  testWidgets('Retry is off once pressed, until the window answers', (t) async {
    await r.open(t, events: [user('u1')], settle: false);
    r.event({'kind': 'voice-text', 'id': 'u1', 'error': 'failed', 'ts': 2});
    await t.pump();
    await t.tap(find.text('Retry'));
    await t.pump();
    // a second tap sends nothing more
    await t.tap(find.text('Retry'), warnIfMissed: false);
    await t.pump();
    expect(r.sent, hasLength(1));
    expect(
      t.widget<TextButton>(find.widgetWithText(TextButton, 'Retry')).onPressed,
      isNull,
    );
    // the window refuses it: Retry is on again
    r.event({
      'kind': 'send-refused',
      'id': r.sent.single['id'],
      'reason': 'switching',
    });
    await t.pump();
    expect(
      t.widget<TextButton>(find.widgetWithText(TextButton, 'Retry')).onPressed,
      isNotNull,
    );
  });

  testWidgets('Retry with the window out of reach says so', (t) async {
    await r.open(t, events: [user('u1')], settle: false);
    r.event({'kind': 'voice-text', 'id': 'u1', 'error': 'failed', 'ts': 2});
    await t.pump();
    r.ch.drop();
    await t.pump();
    await t.tap(find.text('Retry'));
    await t.pump();
    expect(r.sent, isEmpty);
    expect(
      find.text('Sending is off while the window is not reachable'),
      findsWidgets,
    );
    expect(find.byType(SnackBar), findsOneWidget);
  });

  testWidgets(
    'a voice-text that says Whisper is off turns the mic to the install sheet',
    (t) async {
      await r.open(
        t,
        events: [user('u1')],
        settle: false,
        hello: {
          'kind': 'hello',
          'protocol': 14,
          'capabilities': Rig.caps(dictation: 'whisper'),
        },
      );
      expect(r.tab!.whisper, isTrue);
      r.event({'kind': 'voice-text', 'id': 'u1', 'error': 'off', 'ts': 2});
      await t.pump();
      expect(r.tab!.whisper, isFalse);
    },
  );

  Map<String, Object?> hello18() => {
    'kind': 'hello',
    'protocol': 18,
    'capabilities': Rig.caps(dictation: 'whisper'),
  };

  Future<void> detected(WidgetTester t, String? lang, {String pin = ''}) async {
    final v = await VoiceLang.load(MemoryVault());
    if (pin.isNotEmpty) await v.choose(pin);
    r.voiceLang = v;
    await r.open(t, events: [user('u1')], hello: hello18(), settle: false);
    r.event({
      'kind': 'voice-text',
      'id': 'u1',
      'text': 'bonjour',
      'lang': ?lang,
      'ts': 2,
    });
    await t.pump();
  }

  testWidgets('Automatic and a language other than the hint: a badge', (
    t,
  ) async {
    final sem = t.ensureSemantics();
    await detected(t, 'fr');
    expect(find.text('bonjour'), findsOneWidget);
    expect(find.text('FR'), findsOneWidget);
    expect(t.getSemantics(find.text('FR')).label, contains('Recognised as fr'));
    sem.dispose();
  });

  testWidgets('the badge names the six by their own name for screen readers', (
    t,
  ) async {
    final sem = t.ensureSemantics();
    await detected(t, 'de');
    expect(find.text('DE'), findsOneWidget);
    expect(
      t.getSemantics(find.text('DE')).label,
      contains('Recognised as Deutsch'),
    );
    sem.dispose();
  });

  testWidgets('no badge when the language is the hint, or none came', (
    t,
  ) async {
    await detected(t, 'en');
    expect(find.text('EN'), findsNothing);
    await t.pumpWidget(const SizedBox());
    r.dispose();
    r = Rig();
    await detected(t, null);
    expect(find.text('bonjour'), findsOneWidget);
    expect(find.textContaining('Recognised'), findsNothing);
  });

  testWidgets('a pinned language is not a detection: no badge', (t) async {
    await detected(t, 'fr', pin: 'ru');
    expect(find.text('bonjour'), findsOneWidget);
    expect(find.text('FR'), findsNothing);
  });

  testWidgets('a replayed message shows its stored language', (t) async {
    final v = await VoiceLang.load(MemoryVault());
    r.voiceLang = v;
    await r.open(
      t,
      events: [
        {...user('u1', text: 'hallo'), 'voiceLang': 'de'},
      ],
      hello: hello18(),
    );
    expect(find.text('DE'), findsOneWidget);
  });

  testWidgets('folding the transcript keeps the badge beside the play row', (
    t,
  ) async {
    await detected(t, 'fr');
    expect(find.text('FR'), findsOneWidget);
    await t.tap(find.byKey(const ValueKey('fold')));
    await t.pump();
    expect(find.text('bonjour'), findsNothing);
    expect(find.text('FR'), findsOneWidget);
  });

  testWidgets('changing the voice language in Settings updates shown badges', (
    t,
  ) async {
    await detected(t, 'fr');
    expect(find.text('FR'), findsOneWidget);
    await r.voiceLang!.choose('ru');
    await t.pump();
    expect(find.text('FR'), findsNothing);
    await r.voiceLang!.choose(VoiceLang.auto);
    await t.pump();
    expect(find.text('FR'), findsOneWidget);
  });

  testWidgets('Retry of a failed transcription sends detect under Automatic', (
    t,
  ) async {
    r.voiceLang = await VoiceLang.load(MemoryVault());
    await r.open(t, events: [user('u1')], hello: hello18(), settle: false);
    r.event({'kind': 'voice-text', 'id': 'u1', 'error': 'failed', 'ts': 2});
    await t.pump();
    await t.tap(find.text('Retry'));
    await t.pump();
    final m = r.sent.last;
    expect((m['lang'], m['detect']), ('en', true));
  });

  testWidgets('Retry under a pin sends lang alone', (t) async {
    final v = await VoiceLang.load(MemoryVault());
    await v.choose('de');
    r.voiceLang = v;
    await r.open(t, events: [user('u1')], hello: hello18(), settle: false);
    r.event({'kind': 'voice-text', 'id': 'u1', 'error': 'failed', 'ts': 2});
    await t.pump();
    await t.tap(find.text('Retry'));
    await t.pump();
    final m = r.sent.last;
    expect(m['lang'], 'de');
    expect(m.containsKey('detect'), isFalse);
  });
}
