import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/l10n/app_localizations.dart';
import 'package:nb_app/media/markup.dart';
import 'package:nb_app/media/shapes.dart';

Future<Markup> pumpBar(
  WidgetTester t,
  Size size,
  double scale, {
  bool busy = false,
}) async {
  t.view.physicalSize = size;
  t.view.devicePixelRatio = 1;
  t.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(t.view.reset);
  addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
  final m = Markup()..marking = true;
  addTearDown(m.dispose);
  m.add(
    shapeOf(
      MarkTool.rect,
      markColors.first,
      const Offset(.1, .1),
      const Offset(.5, .5),
      const [],
    )!,
  );
  await t.pumpWidget(
    MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        bottomNavigationBar: MarkupToolbar(
          markup: m,
          busy: busy,
          onComment: () {},
        ),
      ),
    ),
  );
  busy
      ? await t.pump(const Duration(milliseconds: 50))
      : await t.pumpAndSettle();
  return m;
}

void main() {
  for (final size in const [Size(320, 640), Size(360, 800)]) {
    for (final scale in const [1.0, 1.5, 2.0]) {
      testWidgets('every tool is reachable at $size, text x$scale', (t) async {
        await pumpBar(t, size, scale);
        expect(t.takeException(), isNull);
        final screen = Offset.zero & size;
        final l = AppLocalizations.of(t.element(find.byType(Scaffold)));
        final names = [
          l.toolRect,
          l.toolEllipse,
          l.toolPen,
          l.toolArrow,
          for (var i = 1; i <= markColors.length; i++) l.markColor(i),
          l.markUndo,
          l.markStop,
        ];
        for (final n in names) {
          final f = find.byTooltip(n);
          expect(f, findsOneWidget, reason: n);
          final r = t.getRect(f);
          expect(
            screen.contains(r.topLeft) &&
                screen.contains(r.bottomRight - const Offset(.1, .1)),
            isTrue,
            reason: '$n at $r',
          );
          await t.tap(f, warnIfMissed: true);
        }
        final c = find.byKey(const ValueKey('markup-comment'));
        expect(c, findsOneWidget);
        final r = t.getRect(c);
        expect(screen.contains(r.topLeft), isTrue);
        expect(r.right, lessThanOrEqualTo(size.width));
        await t.tap(c, warnIfMissed: true);
        for (var i = 1; i <= markColors.length; i++) {
          final s = t.getSize(find.byTooltip(l.markColor(i)));
          expect(s.width, greaterThanOrEqualTo(44));
          expect(s.height, greaterThanOrEqualTo(44));
        }
        expect(t.takeException(), isNull);
      });
    }
  }

  testWidgets('busy shows the spinner in place of Comment, no overflow', (
    t,
  ) async {
    await pumpBar(t, const Size(320, 640), 2.0, busy: true);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byKey(const ValueKey('markup-comment')), findsNothing);
    expect(t.takeException(), isNull);
  });
}
