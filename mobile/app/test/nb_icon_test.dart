import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/ui/nb_icon.dart';

void main() {
  test('svgPath draws lines, relative moves and arcs', () {
    final p = svgPath('M4 20V10M10 20V4M16 20v-7M22 20H2');
    final b = p.getBounds();
    expect(b.left, 2);
    expect(b.top, 4);
    expect(b.right, 22);
    expect(b.bottom, 20);
    final r = svgPath('M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5').getBounds();
    expect(r.left, lessThan(4));
    expect(r.bottom, greaterThan(20));
  });

  test('svgPath rejects an unknown command', () {
    expect(() => svgPath('M0 0X1 1'), throwsFormatException);
  });

  testWidgets('every glyph paints at the given size', (t) async {
    for (final g in NbGlyph.values) {
      await t.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: NbIcon(g, size: 24, color: const Color(0xffffffff)),
          ),
        ),
      );
      expect(t.getSize(find.byType(NbIcon)), const Size(24, 24));
    }
  });
}
