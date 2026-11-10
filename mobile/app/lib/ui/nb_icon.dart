import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// The glyphs of the phone UI, the same drawings as the web's icons
/// (`TabStrip.tsx` ICONS, `CompactClear.tsx`): 24x24 viewBox, stroke 2.
enum NbGlyph {
  back,
  more,
  send,
  mic,
  clip,
  stop,
  expand,
  copy,
  close,
  compact,
  clear,
  restart,
  usage,
  comments,
  settings,
  camera,
  image,
  file,
  share,
  pen,
  play,
  pause,
  lock,
  trash,
  chevronLeft,
  chevronUp,
}

/// One drawn shape of a glyph.
sealed class _Shape {
  const _Shape();
  Path build();
}

class _D extends _Shape {
  const _D(this.d);
  final String d;
  @override
  Path build() => svgPath(d);
}

class _Rect extends _Shape {
  const _Rect(this.x, this.y, this.w, this.h, this.rx);
  final double x, y, w, h, rx;
  @override
  Path build() =>
      Path()
        ..addRRect(RRect.fromLTRBR(x, y, x + w, y + h, Radius.circular(rx)));
}

class _Circle extends _Shape {
  const _Circle(this.cx, this.cy, this.r);
  final double cx, cy, r;
  @override
  Path build() =>
      Path()..addOval(Rect.fromCircle(center: Offset(cx, cy), radius: r));
}

const _settingsD =
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z';

const Map<NbGlyph, List<_Shape>> _shapes = {
  NbGlyph.back: [_D('m12 19-7-7 7-7M19 12H5')],
  NbGlyph.more: [_Circle(12, 5, 1), _Circle(12, 12, 1), _Circle(12, 19, 1)],
  NbGlyph.send: [_D('m22 2-7 20-4-9-9-4zM22 2 11 13')],
  NbGlyph.mic: [
    _D(
      'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
    ),
  ],
  NbGlyph.clip: [
    _D(
      'm21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
    ),
  ],
  NbGlyph.stop: [_Rect(6, 6, 12, 12, 2)],
  NbGlyph.expand: [_D('M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7')],
  NbGlyph.copy: [
    _Rect(9, 9, 13, 13, 2),
    _D('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'),
  ],
  NbGlyph.close: [_D('M18 6 6 18M6 6l12 12')],
  NbGlyph.compact: [
    _D('M4 14h6v6'),
    _D('M20 10h-6V4'),
    _D('m14 10 7-7'),
    _D('m3 21 7-7'),
  ],
  NbGlyph.clear: [
    _D(
      'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21',
    ),
    _D('M22 21H7'),
    _D('m5 11 9 9'),
  ],
  NbGlyph.restart: [_D('M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5')],
  NbGlyph.usage: [_D('M4 20V10M10 20V4M16 20v-7M22 20H2')],
  NbGlyph.comments: [
    _D('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'),
    _D('M8 9h8M8 13h5'),
  ],
  NbGlyph.settings: [_Circle(12, 12, 3), _D(_settingsD)],
  // the web has no such icons: lucide's camera, image, file, share-2 and pen-line, which its other glyphs are
  NbGlyph.camera: [
    _D(
      'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z',
    ),
    _Circle(12, 13, 3),
  ],
  NbGlyph.image: [
    _Rect(3, 3, 18, 18, 2),
    _Circle(9, 9, 2),
    _D('m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'),
  ],
  NbGlyph.file: [
    _D('M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z'),
    _D('M14 2v6h6'),
  ],
  NbGlyph.share: [
    _Circle(18, 5, 3),
    _Circle(6, 12, 3),
    _Circle(18, 19, 3),
    _D('m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98'),
  ],
  NbGlyph.pen: [
    _D('M12 20h9'),
    _D('M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'),
  ],
  // lucide's play, pause, lock, trash-2 and chevrons, drawn the same way
  NbGlyph.play: [_D('M6 4v16l14-8z')],
  NbGlyph.pause: [_Rect(6, 4, 4, 16, 1), _Rect(14, 4, 4, 16, 1)],
  NbGlyph.lock: [_Rect(3, 11, 18, 11, 2), _D('M7 11V7a5 5 0 0 1 10 0v4')],
  NbGlyph.trash: [
    _D(
      'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    ),
    _D('M10 11v6M14 11v6'),
  ],
  NbGlyph.chevronLeft: [_D('m15 18-6-6 6-6')],
  NbGlyph.chevronUp: [_D('m18 15-6-6-6 6')],
};

final Map<NbGlyph, Path> _paths = {
  for (final e in _shapes.entries)
    e.key: e.value.fold<Path>(
      Path(),
      (p, s) => p..addPath(s.build(), Offset.zero),
    ),
};

/// Parses SVG path data (M L H V C S Q A Z, absolute and relative; T is not
/// used by any glyph). Throws [FormatException] on anything else.
Path svgPath(String d) {
  final path = Path();
  var i = 0;
  var x = 0.0, y = 0.0; // current point
  var sx = 0.0, sy = 0.0; // subpath start
  double? cx, cy; // last cubic control point (for S)
  var cmd = '';

  bool isSpace(String c) => c == ' ' || c == ',' || c == '\n' || c == '\t';
  void skip() {
    while (i < d.length && isSpace(d[i])) {
      i++;
    }
  }

  bool atNumber() {
    skip();
    if (i >= d.length) return false;
    final c = d[i];
    return c == '-' || c == '+' || c == '.' || (c.codeUnitAt(0) ^ 0x30) < 10;
  }

  double num() {
    skip();
    final m = RegExp(
      r'[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?',
    ).matchAsPrefix(d, i);
    if (m == null) throw FormatException('number expected', d, i);
    i = m.end;
    return double.parse(m.group(0)!);
  }

  bool flag() {
    skip();
    if (i < d.length && (d[i] == '0' || d[i] == '1')) return d[i++] == '1';
    throw FormatException('arc flag expected', d, i);
  }

  while (true) {
    skip();
    if (i >= d.length) break;
    final c = d[i];
    if ('MmLlHhVvCcSsQqAaZz'.contains(c)) {
      cmd = c;
      i++;
      if (c == 'Z' || c == 'z') {
        path.close();
        x = sx;
        y = sy;
        cx = cy = null;
        continue;
      }
    } else if (!atNumber() || cmd.isEmpty || cmd == 'Z' || cmd == 'z') {
      throw FormatException('unknown path command "$c"', d, i);
    }
    final rel = cmd == cmd.toLowerCase();
    final ox = rel ? x : 0.0, oy = rel ? y : 0.0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + num();
        y = oy + num();
        path.moveTo(x, y);
        sx = x;
        sy = y;
        cmd = rel ? 'l' : 'L'; // further pairs are lines
        cx = cy = null;
      case 'L':
        x = ox + num();
        y = oy + num();
        path.lineTo(x, y);
        cx = cy = null;
      case 'H':
        x = ox + num();
        path.lineTo(x, y);
        cx = cy = null;
      case 'V':
        y = oy + num();
        path.lineTo(x, y);
        cx = cy = null;
      case 'C':
        final x1 = ox + num(), y1 = oy + num();
        final x2 = ox + num(), y2 = oy + num();
        x = ox + num();
        y = oy + num();
        path.cubicTo(x1, y1, x2, y2, x, y);
        cx = x2;
        cy = y2;
      case 'S':
        final x1 = cx == null ? x : 2 * x - cx;
        final y1 = cy == null ? y : 2 * y - cy;
        final x2 = ox + num(), y2 = oy + num();
        x = ox + num();
        y = oy + num();
        path.cubicTo(x1, y1, x2, y2, x, y);
        cx = x2;
        cy = y2;
      case 'Q':
        final x1 = ox + num(), y1 = oy + num();
        x = ox + num();
        y = oy + num();
        path.quadraticBezierTo(x1, y1, x, y);
        cx = cy = null;
      case 'A':
        final rx = num(), ry = num(), rot = num();
        final large = flag(), sweep = flag();
        x = ox + num();
        y = oy + num();
        path.arcToPoint(
          Offset(x, y),
          radius: Radius.elliptical(rx.abs(), ry.abs()),
          rotation: rot * math.pi / 180,
          largeArc: large,
          clockwise: sweep,
        );
        cx = cy = null;
    }
  }
  return path;
}

/// A glyph painted at [size] from its 24x24 drawing: stroke 2 (scaled), round
/// caps and joins, no fill. [color] null follows the ambient [IconTheme].
class NbIcon extends StatelessWidget {
  const NbIcon(this.glyph, {super.key, this.size = 20, this.color});

  final NbGlyph glyph;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = color ?? IconTheme.of(context).color ?? const Color(0xff000000);
    return SizedBox.square(
      dimension: size,
      child: CustomPaint(painter: _NbIconPainter(glyph, c)),
    );
  }
}

class _NbIconPainter extends CustomPainter {
  _NbIconPainter(this.glyph, this.color);
  final NbGlyph glyph;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / 24;
    canvas.scale(k);
    canvas.drawPath(
      _paths[glyph]!,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = color,
    );
  }

  @override
  bool shouldRepaint(_NbIconPainter o) => o.glyph != glyph || o.color != color;
}
