// geometry.ts and render.ts of the web, against the desktop's own results (web/src/media/markup/mobileParity.test.ts).
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/media/shapes.dart';
import 'package:nb_protocol/nb_protocol.dart';

void main() {
  final data =
      jsonDecode(File('test/fixtures/media/shapes.json').readAsStringSync())
          as Map<String, Object?>;
  final shapes = [
    for (final s in data['shapes'] as List)
      MediaShape.fromJson((s as Map).cast<String, Object?>()),
  ];
  List<double> nums(Object? v) => [
    for (final x in v as List) (x as num).toDouble(),
  ];

  test('describeShape matches the desktop', () {
    for (final d in data['describe'] as List) {
      final m = d as Map;
      expect([
        for (final s in shapes) describeShape(s, m['w'] as int, m['h'] as int),
      ], m['lines']);
    }
  });

  test('mediaTime matches the desktop', () {
    for (final t in data['times'] as List) {
      expect(mediaTime(((t as Map)['t'] as num).toDouble()), t['text']);
    }
  });

  test('simplify matches the desktop', () {
    for (final p in data['simplify'] as List) {
      final points = nums((p as Map)['points']);
      for (final e in p['eps'] as List) {
        expect(
          simplify(points, ((e as Map)['e'] as num).toDouble()),
          nums(e['out']),
        );
      }
    }
  });

  test('rectFrom matches the desktop', () {
    for (final c in data['rectFrom'] as List) {
      Offset pt(Object? v) => Offset(
        ((v as Map)['x'] as num).toDouble(),
        (v['y'] as num).toDouble(),
      );
      final r = rectFrom(pt((c as Map)['a']), pt(c['b']));
      final want = c['r'] as Map;
      expect(
        [r.x, r.y, r.w, r.h],
        [
          for (final k in ['x', 'y', 'w', 'h']) (want[k] as num).toDouble(),
        ],
      );
    }
  });

  test('jsNum writes numbers as JavaScript does', () {
    expect(jsNum(1), '1');
    expect(jsNum(1.0), '1');
    expect(jsNum(0.5), '0.5');
    expect(jsNum(-0.0), '0');
    expect(jsNum(0.000001), '0.000001');
    expect(jsNum(1e-7), '1e-7');
    expect(jsNum(1e21), '1e+21');
    expect(jsNum(123456789012), '123456789012');
  });

  group('shapeOf (MarkupLayer)', () {
    const red = MarkColor.v_ff3b30;
    test('a box tool makes a normalised box, nothing without extent', () {
      final s =
          shapeOf(
                MarkTool.rect,
                red,
                const Offset(0.5, 0.6),
                const Offset(0.2, 0.1),
                const [],
              )!
              as MediaShapeRectOrEllipse;
      expect(
        [s.kind, s.x, s.y, s.w, s.h],
        [MediaShapeRectOrEllipseKind.rect, 0.2, 0.1, 0.3, 0.5],
      );
      expect(
        shapeOf(
          MarkTool.ellipse,
          red,
          const Offset(0.5, 0.6),
          const Offset(0.5, 0.9),
          const [],
        ),
        isNull,
      );
      expect(
        shapeOf(
          MarkTool.arrow,
          red,
          const Offset(0.5, 0.6),
          const Offset(0.5, 0.6),
          const [],
        ),
        isNull,
      );
    });

    test('a pen tap is a dot; a long stroke stays under the cap', () {
      final dot =
          shapeOf(MarkTool.pen, red, Offset.zero, Offset.zero, const [
                0.3,
                0.3,
              ])!
              as MediaShapePen;
      expect(dot.points, [0.3, 0.3, 0.3, 0.3]);
      final long = [
        for (var i = 0; i < 30000; i++) ...[i / 30000, (i % 7) / 7],
      ];
      final pen =
          shapeOf(MarkTool.pen, red, Offset.zero, Offset.zero, long)!
              as MediaShapePen;
      expect(pen.points.length, lessThanOrEqualTo(penMaxValues));
      expect(pen.points.length, greaterThan(2));
    });
  });

  test('toRel is clamped to the content box, 4 decimals', () {
    final b = containBox(const Size(100, 300), const Size(200, 100));
    expect(b, const Rect.fromLTWH(0, 125, 100, 50));
    expect(toRel(const Offset(50, 150), b), const Offset(0.5, 0.5));
    expect(toRel(const Offset(-10, 0), b), Offset.zero);
    expect(toRel(const Offset(33.33333, 400), b), const Offset(0.3333, 1));
  });

  test('strokeWidth and painting do not throw', () {
    expect(strokeWidth(1920, 1080), 4);
    expect(strokeWidth(100, 100), 3);
    final rec = ui.PictureRecorder();
    paintShapes(
      Canvas(rec),
      [
        ...shapes,
        const MediaShapePen(color: MarkColor.v_ff3b30, points: [0.5]),
      ],
      200,
      100,
    );
    final img = rec.endRecording().toImageSync(200, 100);
    expect(img.width, 200);
  });
}
