// The pictures of a media comment, as the desktop makes them (web/src/media/markup/render.ts and prepareImage of
// web/src/attachments/image.ts): `frame.jpg` (the source with the marks, q 90, white under it) and `layer.png` (the
// marks alone) at the natural size, downscaled ×0.75 until both fit MARK_MAX_BYTES; and the frame for the agent.
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:image/image.dart' as img;
import 'package:nb_protocol/nb_protocol.dart';

import 'shapes.dart';

/// the largest mark image the server takes (`MARK_MAX_BYTES`)
const markMaxBytes = 25 * 1024 * 1024;

/// the agent's picture: its longest edge and its size before it turns to JPEG (`IMG_EDGE`, `IMG_BYTES`)
const imgEdge = 1568;
const imgBytes = 3500000;

Uint8List _jpeg((Uint8List, int, int, int) a) => img.encodeJpg(
  img.Image.fromBytes(
    width: a.$2,
    height: a.$3,
    bytes: a.$1.buffer,
    numChannels: 4,
  ),
  quality: a.$4,
);

/// JPEG of [image] at [quality], encoded off the UI thread.
Future<Uint8List> encodeJpeg(ui.Image image, int quality) async {
  final raw = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  return compute(_jpeg, (
    raw!.buffer.asUint8List(),
    image.width,
    image.height,
    quality,
  ));
}

Future<Uint8List> encodePng(ui.Image image) async => (await image.toByteData(
  format: ui.ImageByteFormat.png,
))!.buffer.asUint8List();

ui.Image _draw(int w, int h, void Function(Canvas c) paint) {
  final rec = ui.PictureRecorder();
  paint(Canvas(rec));
  return rec.endRecording().toImageSync(w, h);
}

/// [composite]: the frame as drawn (the caller disposes it), for [agentImage].
Future<({Uint8List frame, Uint8List layer, double scale, ui.Image composite})>
renderMarks(
  ui.Image source,
  int w,
  int h,
  List<MediaShape> shapes, {
  int maxBytes = markMaxBytes,
}) async {
  var scale = 1.0;
  for (;;) {
    final pw = math.max(1, (w * scale).round()),
        ph = math.max(1, (h * scale).round());
    final dst = Rect.fromLTWH(0, 0, pw.toDouble(), ph.toDouble());
    final f = _draw(pw, ph, (c) {
      c.drawRect(dst, Paint()..color = const Color(0xffffffff));
      c.drawImageRect(
        source,
        Rect.fromLTWH(0, 0, source.width.toDouble(), source.height.toDouble()),
        dst,
        Paint()..filterQuality = FilterQuality.medium,
      );
      paintShapes(c, shapes, pw.toDouble(), ph.toDouble());
    });
    final l = _draw(
      pw,
      ph,
      (c) => paintShapes(c, shapes, pw.toDouble(), ph.toDouble()),
    );
    final frame = await encodeJpeg(f, 90), layer = await encodePng(l);
    l.dispose();
    if ((frame.length <= maxBytes && layer.length <= maxBytes) ||
        (pw == 1 && ph == 1)) {
      return (frame: frame, layer: layer, scale: scale, composite: f);
    }
    f.dispose();
    scale *= 0.75;
  }
}

/// The frame as the agent gets it: [jpeg] as it is when small enough, else redrawn to at most [imgEdge] px on its long
/// edge, PNG unless that is over [imgBytes], then JPEG 0.9.
Future<({Uint8List bytes, String type})> agentImage(
  ui.Image frame,
  Uint8List jpeg,
) async {
  final s = math.min(1.0, imgEdge / math.max(frame.width, frame.height));
  if (s == 1 && jpeg.length <= imgBytes) {
    return (bytes: jpeg, type: 'image/jpeg');
  }
  final w = (frame.width * s).round(), h = (frame.height * s).round();
  final small = _draw(
    w,
    h,
    (c) => c.drawImageRect(
      frame,
      Rect.fromLTWH(0, 0, frame.width.toDouble(), frame.height.toDouble()),
      Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()),
      Paint()..filterQuality = FilterQuality.medium,
    ),
  );
  try {
    final png = await encodePng(small);
    if (png.length <= imgBytes) return (bytes: png, type: 'image/png');
    return (bytes: await encodeJpeg(small, 90), type: 'image/jpeg');
  } finally {
    small.dispose();
  }
}
