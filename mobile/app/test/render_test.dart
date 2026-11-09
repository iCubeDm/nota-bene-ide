// render.ts and prepareImage of the web: the files a media comment leaves on the host and the picture sent to the agent.
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:nb_app/media/render.dart';
import 'package:nb_protocol/nb_protocol.dart';

Future<ui.Image> solid(int w, int h, Color color) async {
  final rec = ui.PictureRecorder();
  Canvas(rec).drawRect(
    Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()),
    Paint()..color = color,
  );
  return rec.endRecording().toImage(w, h);
}

const box = MediaShapeRectOrEllipse(
  kind: MediaShapeRectOrEllipseKind.rect,
  color: MarkColor.v_ffffff,
  x: 0.25,
  y: 0.25,
  w: 0.5,
  h: 0.5,
);

void main() {
  testWidgets('frame.jpg has the source and the marks, layer.png the marks', (
    t,
  ) async {
    await t.runAsync(() async {
      final src = await solid(40, 20, const Color(0xffff0000));
      final r = await renderMarks(src, 40, 20, [box]);
      expect(r.scale, 1);
      expect(r.frame.sublist(0, 3), [0xff, 0xd8, 0xff]);
      final f = img.decodeJpg(r.frame)!;
      expect((f.width, f.height), (40, 20));
      final edge = f.getPixel(10, 10), mid = f.getPixel(20, 10);
      expect(edge.g, greaterThan(180), reason: 'the white box');
      expect((mid.r > 180, mid.g < 80), (true, true), reason: 'the red source');
      expect(r.layer.sublist(0, 4), [0x89, 0x50, 0x4e, 0x47]);
      final l = img.decodePng(r.layer)!;
      expect(l.getPixel(20, 10).a, 0);
      expect(l.getPixel(10, 10).a, greaterThan(0));
      r.composite.dispose();
    });
  });

  testWidgets('files over the cap are downscaled and say so', (t) async {
    await t.runAsync(() async {
      final src = await solid(400, 200, const Color(0xff336699));
      final r = await renderMarks(src, 400, 200, [box], maxBytes: 2000);
      expect(r.scale, lessThan(1));
      expect(r.frame.length, lessThanOrEqualTo(2000));
      final f = img.decodeJpg(r.frame)!;
      expect(f.width, (400 * r.scale).round());
      r.composite.dispose();
    });
  });

  testWidgets('the agent gets the frame at most 1568 px on its long edge', (
    t,
  ) async {
    await t.runAsync(() async {
      final big = await solid(4000, 1000, const Color(0xff00ff00));
      final a = await agentImage(big, Uint8List(10));
      expect(a.type, 'image/png');
      final d = img.decodeImage(a.bytes)!;
      expect((d.width, d.height), (1568, 392));
      final small = await solid(100, 50, const Color(0xff00ff00));
      final jpeg = Uint8List.fromList([0xff, 0xd8, 0xff, 1]);
      final s = await agentImage(small, jpeg);
      expect((s.type, s.bytes), ('image/jpeg', jpeg), reason: 'as it is');
    });
  });
}
