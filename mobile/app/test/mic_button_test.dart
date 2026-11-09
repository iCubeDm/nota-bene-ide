import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/comment_sheet.dart';
import 'package:nb_app/dictation/dictation.dart';
import 'package:nb_app/dictation/mic_button.dart';
import 'package:nb_app/main.dart';

class FakeDictation implements Dictation {
  final sessions = <StreamController<DictationEvent>>[];
  final tags = <String>[];
  final calls = <String>[];

  StreamController<DictationEvent> get last => sessions.last;

  @override
  Stream<DictationEvent> listen(String languageTag) {
    tags.add(languageTag);
    calls.add('listen');
    final c = StreamController<DictationEvent>();
    sessions.add(c);
    return c.stream;
  }

  @override
  Future<void> stop() async => calls.add('stop');

  @override
  Future<void> cancel() async => calls.add('cancel');
}

void main() {
  late FakeDictation fake;
  late Dictation saved;
  setUp(() {
    saved = dictation;
    dictation = fake = FakeDictation();
  });
  tearDown(() => dictation = saved);

  Future<TextEditingController> pump(
    WidgetTester t, {
    String text = '',
    bool show = true,
    ValueNotifier<bool>? enabled,
  }) async {
    final c = TextEditingController(text: text);
    c.selection = TextSelection.collapsed(offset: text.length);
    await t.pumpWidget(
      NbApp(
        home: Scaffold(
          body: show
              ? ValueListenableBuilder<bool>(
                  valueListenable: enabled ?? ValueNotifier(true),
                  builder: (_, on, _) => Row(
                    children: [
                      Expanded(child: TextField(controller: c)),
                      MicButton(controller: c, enabled: on),
                    ],
                  ),
                )
              : const SizedBox(),
        ),
      ),
    );
    return c;
  }

  testWidgets('partials then final land at the cursor', (t) async {
    final c = await pump(t, text: 'Fix ');
    expect(find.byTooltip('Dictate'), findsOneWidget);
    await t.tap(find.byTooltip('Dictate'));
    await t.pump();
    expect(find.byTooltip('Stop dictation'), findsOneWidget);
    fake.last.add(const DictationPartial('the'));
    await t.pump();
    expect(c.text, 'Fix the');
    fake.last.add(const DictationPartial('the head'));
    await t.pump();
    expect(c.text, 'Fix the head');
    fake.last.add(const DictationFinal('the header'));
    fake.last.add(const DictationEnd());
    await t.pump();
    expect(c.text, 'Fix the header');
    expect(c.selection.baseOffset, 'Fix the header'.length);
    expect(find.byTooltip('Dictate'), findsOneWidget);
  });

  testWidgets('a space separates words from text that does not end in one', (
    t,
  ) async {
    final c = await pump(t, text: 'Fix');
    await t.tap(find.byTooltip('Dictate'));
    await t.pump();
    fake.last.add(const DictationFinal('it'));
    await t.pump();
    expect(c.text, 'Fix it');
  });

  testWidgets('tapping again stops', (t) async {
    await pump(t);
    await t.tap(find.byTooltip('Dictate'));
    await t.pump();
    await t.tap(find.byTooltip('Stop dictation'));
    await t.pump();
    expect(fake.calls, ['listen', 'stop']);
  });

  testWidgets('denied shows a snackbar and leaves the field', (t) async {
    final c = await pump(t, text: 'Fix ');
    await t.tap(find.byTooltip('Dictate'));
    await t.pump();
    fake.last.add(const DictationPartial('abc'));
    fake.last.add(const DictationError(DictationFailure.denied));
    fake.last.add(const DictationEnd());
    await t.pump();
    expect(find.text('Microphone access is off for Nota Bene'), findsOneWidget);
    expect(c.text, 'Fix ');
  });

  testWidgets('leaving while listening cancels and ignores later events', (
    t,
  ) async {
    final c = await pump(t, text: 'Fix ');
    await t.tap(find.byTooltip('Dictate'));
    await t.pump();
    await t.pumpWidget(const SizedBox());
    expect(fake.calls, ['listen', 'cancel']);
    fake.last.add(const DictationFinal('late'));
    await t.pump();
    expect(c.text, 'Fix ');
  });

  testWidgets('disabling while listening cancels', (t) async {
    final on = ValueNotifier(true);
    await pump(t, enabled: on);
    await t.tap(find.byTooltip('Dictate'));
    await t.pump();
    on.value = false;
    await t.pump();
    expect(fake.calls, ['listen', 'cancel']);
  });

  testWidgets('starting one mic cancels another', (t) async {
    final a = TextEditingController();
    final b = TextEditingController();
    await t.pumpWidget(
      NbApp(
        home: Scaffold(
          body: Column(
            children: [
              MicButton(key: const Key('a'), controller: a),
              MicButton(key: const Key('b'), controller: b),
            ],
          ),
        ),
      ),
    );
    await t.tap(find.byKey(const Key('a')));
    await t.pump();
    await t.tap(find.byKey(const Key('b')));
    await t.pump();
    expect(fake.calls, ['listen', 'cancel', 'listen']);
    fake.sessions.first.add(const DictationFinal('stale'));
    await t.pump();
    expect(a.text, '');
  });

  testWidgets('the language tag follows the UI, not the device', (t) async {
    t.platformDispatcher.localeTestValue = const Locale('ja', 'JP');
    addTearDown(t.platformDispatcher.clearLocaleTestValue);
    await pump(t);
    await t.tap(find.byTooltip('Dictate'));
    await t.pump();
    expect(fake.tags, ['en']);
  });

  testWidgets('the comment sheet has a mic', (t) async {
    await t.pumpWidget(
      NbApp(
        home: Builder(
          builder: (c) => TextButton(
            onPressed: () => showCommentSheet(c, quote: 'q'),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await t.tap(find.text('open'));
    await t.pumpAndSettle();
    expect(find.byTooltip('Dictate'), findsOneWidget);
  });
}
