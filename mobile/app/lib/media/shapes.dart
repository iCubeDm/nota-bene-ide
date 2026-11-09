// Media marks as the desktop makes them (web/src/media/markup: geometry.ts, render.ts, MarkupLayer's shapeOf): shapes
// relative to the media's natural size, their batch lines, and their painting, so a mark made here reads and looks
// the same on the desktop. Checked against the desktop's own results in test/shapes_test.dart.
import 'dart:math' as math;
import 'dart:ui';

import 'package:nb_protocol/nb_protocol.dart';

/// the most values (x and y each count) a pen stroke may carry (`PEN_MAX_VALUES`)
const penMaxValues = 20000;

/// The desktop's colours, in its toolbar's order.
const markColors = [
  MarkColor.v_ff3b30,
  MarkColor.v_ffcc00,
  MarkColor.v_34c759,
  MarkColor.v_0a84ff,
  MarkColor.v_ffffff,
];

Color colorOf(MarkColor c) =>
    Color(0xff000000 | int.parse(c.toJson().substring(1), radix: 16));

enum MarkTool { rect, ellipse, pen, arrow }

/// JavaScript's `Math.round`: halves go up.
int _jsRound(double v) => (v + 0.5).floor();

double round4(double v) => _jsRound(v * 10000) / 10000;

/// A number as JavaScript's `String(v)` writes it (Dart writes a whole double as `1.0`).
String jsNum(num v) {
  if (v is int) return '$v';
  if (v == 0) return '0';
  if (v == v.truncateToDouble() && v.abs() < 1e21) return '${v.toInt()}';
  return '$v';
}

/// `object-fit: contain` of [natural] inside a [box] at the origin.
Rect containBox(Size box, Size natural) {
  if (natural.width <= 0 || natural.height <= 0) return Offset.zero & box;
  final s = math.min(box.width / natural.width, box.height / natural.height);
  final w = natural.width * s, h = natural.height * s;
  return Rect.fromLTWH((box.width - w) / 2, (box.height - h) / 2, w, h);
}

/// A point → relative [0,1]², clamped, 4 decimals.
Offset toRel(Offset p, Rect b) => Offset(
  b.width > 0 ? round4(((p.dx - b.left) / b.width).clamp(0.0, 1.0)) : 0,
  b.height > 0 ? round4(((p.dy - b.top) / b.height).clamp(0.0, 1.0)) : 0,
);

/// Drops pen points closer than [eps] (relative) to the previous kept one; always keeps the first and last.
List<double> simplify(List<double> points, [double eps = 0.0015]) {
  final n = points.length ~/ 2;
  if (n <= 2) return [...points];
  final out = [points[0], points[1]];
  for (var i = 1; i < n - 1; i++) {
    final x = points[2 * i], y = points[2 * i + 1];
    final dx = x - out[out.length - 2], dy = y - out[out.length - 1];
    if (math.sqrt(dx * dx + dy * dy) >= eps) out.addAll([x, y]);
  }
  out.addAll([points[2 * n - 2], points[2 * n - 1]]);
  return out;
}

/// A normalised box from a drag's two corners (any direction).
({double x, double y, double w, double h}) rectFrom(Offset a, Offset b) => (
  x: round4(math.min(a.dx, b.dx)),
  y: round4(math.min(a.dy, b.dy)),
  w: round4((a.dx - b.dx).abs()),
  h: round4((a.dy - b.dy).abs()),
);

/// A finished drag as a shape, or null when it has no extent (a tap with a box tool is not a drawing). [a] and [b]
/// are the relative ends; [pen] the relative points of a pen stroke.
MediaShape? shapeOf(
  MarkTool tool,
  MarkColor color,
  Offset a,
  Offset b,
  List<double> pen,
) {
  switch (tool) {
    case MarkTool.pen:
      var pts = simplify(pen);
      if (pts.length == 2) pts = [pts[0], pts[1], pts[0], pts[1]]; // a dot
      for (var eps = 0.003; pts.length > penMaxValues; eps *= 2) {
        pts = simplify(pen, eps);
      }
      return pts.length < 2 ? null : MediaShapePen(color: color, points: pts);
    case MarkTool.arrow:
      return a == b
          ? null
          : MediaShapeArrow(
              color: color,
              x1: a.dx,
              y1: a.dy,
              x2: b.dx,
              y2: b.dy,
            );
    case MarkTool.rect || MarkTool.ellipse:
      final r = rectFrom(a, b);
      if (r.w <= 0 || r.h <= 0) return null;
      return MediaShapeRectOrEllipse(
        kind: tool == MarkTool.rect
            ? MediaShapeRectOrEllipseKind.rect
            : MediaShapeRectOrEllipseKind.ellipse,
        color: color,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
      );
  }
}

String _n(num v) => jsNum(round4(v.toDouble()));
int _px(num v, int nat) => _jsRound(v * nat.toDouble());

/// One line per shape for the batch, e.g. `rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)`.
String describeShape(MediaShape s, int natW, int natH) => switch (s) {
  MediaShapeRectOrEllipse(kind: MediaShapeRectOrEllipseKind.ellipse) =>
    _ellipse(s, natW, natH),
  MediaShapeRectOrEllipse(:final x, :final y, :final w, :final h) =>
    'rect x=${_n(x)} y=${_n(y)} w=${_n(w)} h=${_n(h)} (px ${_px(x, natW)},${_px(y, natH)} ${_px(w, natW)}×${_px(h, natH)})',
  MediaShapeArrow(:final x1, :final y1, :final x2, :final y2) =>
    'arrow (${_n(x1)},${_n(y1)})→(${_n(x2)},${_n(y2)}) (px ${_px(x1, natW)},${_px(y1, natH)}→${_px(x2, natW)},${_px(y2, natH)})',
  MediaShapePen(:final points) => _pen(points, natW, natH),
  MediaShapeUnknown() => '',
};

String _ellipse(MediaShapeRectOrEllipse s, int natW, int natH) {
  final cx = s.x + s.w / 2, cy = s.y + s.h / 2, rx = s.w / 2, ry = s.h / 2;
  return 'ellipse cx=${_n(cx)} cy=${_n(cy)} rx=${_n(rx)} ry=${_n(ry)} (px ${_px(cx, natW)},${_px(cy, natH)} r ${_px(rx, natW)}×${_px(ry, natH)})';
}

String _pen(List<num> p, int natW, int natH) {
  var minX = double.infinity, minY = double.infinity;
  var maxX = double.negativeInfinity, maxY = double.negativeInfinity;
  for (var i = 0; i + 1 < p.length; i += 2) {
    minX = math.min(minX, p[i].toDouble());
    maxX = math.max(maxX, p[i].toDouble());
    minY = math.min(minY, p[i + 1].toDouble());
    maxY = math.max(maxY, p[i + 1].toDouble());
  }
  final w = maxX - minX, h = maxY - minY;
  return 'pen ${p.length ~/ 2} pts, bbox x=${_n(minX)} y=${_n(minY)} w=${_n(w)} h=${_n(h)} (px ${_px(minX, natW)},${_px(minY, natH)} ${_px(w, natW)}×${_px(h, natH)})';
}

/// `m:ss.mmm`
String mediaTime(double t) {
  final ms = _jsRound(t * 1000);
  final m = ms ~/ 60000, rest = ms - m * 60000;
  return '$m:${'${rest ~/ 1000}'.padLeft(2, '0')}.${'${rest % 1000}'.padLeft(3, '0')}';
}

/// The stroke width of shapes drawn on a w×h picture.
double strokeWidth(num w, num h) =>
    math.max(3, _jsRound(math.min(w, h) / 250)).toDouble();

const _headAngle = 25 * math.pi / 180;

/// Draws [shapes] on a canvas sized [w]×[h] (relative → px), as the desktop's `drawShapes`.
void paintShapes(
  Canvas c,
  List<MediaShape> shapes,
  double w,
  double h, {
  double? lineWidth,
}) {
  final lw = lineWidth ?? strokeWidth(w, h);
  for (final s in shapes) {
    final color = switch (s) {
      MediaShapeRectOrEllipse(:final color) ||
      MediaShapeArrow(:final color) ||
      MediaShapePen(:final color) => color,
      MediaShapeUnknown() => null,
    };
    if (color == null) continue;
    final paint = Paint()
      ..color = colorOf(color)
      ..style = PaintingStyle.stroke
      ..strokeWidth = lw
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    switch (s) {
      case MediaShapeRectOrEllipse(:final kind, :final x, :final y):
        final r = Rect.fromLTWH(x * w, y * h, s.w * w, s.h * h);
        if (kind == MediaShapeRectOrEllipseKind.ellipse) {
          c.drawOval(r, paint);
        } else {
          c.drawRect(r, paint);
        }
      case MediaShapeArrow(:final x1, :final y1, :final x2, :final y2):
        final a = Offset(x1 * w, y1 * h), b = Offset(x2 * w, y2 * h);
        final back = math.atan2(a.dy - b.dy, a.dx - b.dx);
        final len = math.max(12.0, 4 * lw);
        final path = Path()
          ..moveTo(a.dx, a.dy)
          ..lineTo(b.dx, b.dy);
        for (final t in [back + _headAngle, back - _headAngle]) {
          path
            ..moveTo(b.dx, b.dy)
            ..lineTo(b.dx + len * math.cos(t), b.dy + len * math.sin(t));
        }
        c.drawPath(path, paint);
      case MediaShapePen(:final points):
        if (points.length < 2) break;
        final path = Path()..moveTo(points[0] * w, points[1] * h);
        for (var i = 2; i + 1 < points.length; i += 2) {
          path.lineTo(points[i] * w, points[i + 1] * h);
        }
        // a dot (a tap) is a zero-length line: round caps draw it, as the desktop's canvas does
        c.drawPath(path, paint);
      case MediaShapeUnknown():
        break;
    }
  }
}
