import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/theme.dart';
import 'package:nb_app/ui/blur_band.dart';

// Pixels, not widgets: a backdrop filter inside a mask reads an empty layer and blurs nothing, so the bands are rendered
// over black and white stripes and the rows at each end are read back.
void main() {
  const h = 200;

  Widget stripes() => Column(
    children: [
      for (var i = 0; i < h ~/ 4; i++)
        Container(height: 4, color: i.isEven ? Colors.black : Colors.white),
    ],
  );

  /// The red channel down the middle column of the band over the stripes.
  Future<List<int>> column(WidgetTester t, BlurBand band, bool top) async {
    final key = GlobalKey();
    await t.pumpWidget(
      MaterialApp(
        theme: NbTheme.byId(null).data,
        home: Center(
          child: RepaintBoundary(
            key: key,
            child: SizedBox(
              width: 100,
              height: 200,
              child: BackdropGroup(
                child: Stack(
                  children: [
                    Positioned.fill(child: stripes()),
                    Positioned(
                      top: top ? 0 : null,
                      bottom: top ? null : 0,
                      left: 0,
                      right: 0,
                      height: 200,
                      child: band,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    final ro = key.currentContext!.findRenderObject() as RenderRepaintBoundary;
    late List<int> out;
    await t.runAsync(() async {
      final img = await ro.toImage();
      final data = (await img.toByteData())!;
      out = [for (var y = 0; y < h; y++) data.getUint8((y * 100 + 50) * 4)];
    });
    return out;
  }

  int spread(List<int> c, int from, int to) {
    final s = c.sublist(from, to);
    return s.reduce((a, b) => a > b ? a : b) -
        s.reduce((a, b) => a < b ? a : b);
  }

  testWidgets('the top band is blurred at the screen edge, clear at its end', (
    t,
  ) async {
    final c = await column(t, const BlurBand(top: true), true);
    expect(spread(c, 0, 8), lessThan(40));
    expect(spread(c, 192, 200), greaterThan(150));
  });

  testWidgets('the bottom band is clear where it starts, blurred below', (
    t,
  ) async {
    final c = await column(
      t,
      const BlurBand(top: false, fade: blurFade),
      false,
    );
    expect(spread(c, 0, 8), greaterThan(150));
    expect(spread(c, 192, 200), lessThan(40));
  });
}
