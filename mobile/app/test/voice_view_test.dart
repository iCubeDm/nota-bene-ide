import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/voice/player.dart';
import 'package:nb_app/voice/voice_view.dart';

import 'support/voice_fakes.dart';

void main() {
  late Player native;
  late VoicePlayer p;
  setUp(() {
    native = Player()..install();
    p = VoicePlayer(files: MemoryVoiceFiles());
  });
  tearDown(() => native.uninstall());

  Future<void> pump(WidgetTester t, {int ms = 12000}) => t.pumpWidget(
    NbApp(
      home: Scaffold(
        body: Center(
          child: VoiceView(
            id: 'v1',
            ms: ms,
            wave: [for (var i = 0; i < 48; i++) i % 32],
            load: () async => Uint8List.fromList([1]),
            player: p,
          ),
        ),
      ),
    ),
  );

  testWidgets('shows the length and 48 bars; play plays, pause pauses', (
    t,
  ) async {
    await pump(t);
    expect(find.text('0:12'), findsOneWidget);
    expect(
      t.widget<CustomPaint>(find.byKey(const ValueKey('wave'))).painter,
      isA<WavePainter>(),
    );
    expect(
      (t.widget<CustomPaint>(find.byKey(const ValueKey('wave'))).painter
              as WavePainter)
          .wave,
      hasLength(48),
    );
    await t.tap(find.byTooltip('Play'));
    await t.pump();
    expect(native.names, ['play']);
    expect(find.byTooltip('Pause'), findsOneWidget);
    await t.tap(find.byTooltip('Pause'));
    await t.pump();
    expect(native.names, ['play', 'pause']);
  });

  testWidgets('the position replaces the length while it plays', (t) async {
    await pump(t);
    await t.tap(find.byTooltip('Play'));
    await t.pump();
    await native.call('position', {'ms': 3400});
    await t.pump();
    expect(find.text('0:03'), findsOneWidget);
    expect(find.text('0:12'), findsNothing);
  });

  testWidgets('a tap on the wave seeks there', (t) async {
    await pump(t);
    final box = t.getRect(find.byKey(const ValueKey('wave')));
    await t.tapAt(Offset(box.left + box.width / 2, box.center.dy));
    await t.pump();
    expect(native.calls.last.method, 'play');
    final from = (native.calls.last.arguments as Map)['from'] as int;
    expect(from, closeTo(6000, 150));
    await t.tapAt(Offset(box.left + box.width * .75, box.center.dy));
    await t.pump();
    expect(native.calls.last.method, 'seek');
    expect(
      ((native.calls.last.arguments as Map)['ms']) as int,
      closeTo(9000, 150),
    );
  });
}
