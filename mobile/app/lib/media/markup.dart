// Drawing on a picture, as the desktop's MarkupLayer and MarkupToolbar: the four tools and five colours, shapes
// relative to the picture's natural size over its contained box; the comments already on it drawn with their number.
import 'dart:math' as math;

import 'package:flutter/gestures.dart' show DragStartBehavior;
import 'package:flutter/material.dart';
import 'package:nb_protocol/nb_protocol.dart';

import '../l10n/app_localizations.dart';
import 'shapes.dart';

class Markup extends ChangeNotifier {
  bool _marking = false;
  bool get marking => _marking;
  set marking(bool v) {
    _marking = v;
    if (!v) shapes.clear();
    notifyListeners();
  }

  MarkTool _tool = MarkTool.rect;
  MarkTool get tool => _tool;
  set tool(MarkTool v) {
    _tool = v;
    notifyListeners();
  }

  MarkColor _color = markColors.first;
  MarkColor get color => _color;
  set color(MarkColor v) {
    _color = v;
    notifyListeners();
  }

  final shapes = <MediaShape>[];

  void add(MediaShape s) {
    shapes.add(s);
    notifyListeners();
  }

  void undo() {
    if (shapes.isEmpty) return;
    shapes.removeLast();
    notifyListeners();
  }
}

/// A comment's shapes on the picture, with its number in the strip.
typedef ShownMark = ({int n, List<MediaShape> shapes, bool sent});

/// [child] (the picture, drawn to fill the box it is given) placed in its contained box, with the marks over it.
class MarkupLayer extends StatefulWidget {
  const MarkupLayer({
    super.key,
    required this.natural,
    required this.markup,
    required this.shown,
    required this.child,
  });

  final Size natural;
  final Markup markup;
  final List<ShownMark> shown;
  final Widget child;

  @override
  State<MarkupLayer> createState() => _MarkupLayerState();
}

class _MarkupLayerState extends State<MarkupLayer> {
  Offset? _a, _b;
  final _pen = <double>[];

  MediaShape? get _live {
    final a = _a, b = _b;
    if (a == null || b == null) return null;
    final m = widget.markup;
    return shapeOf(m.tool, m.color, a, b, _pen);
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final content = containBox(box.biggest, widget.natural);
      return ListenableBuilder(
        listenable: widget.markup,
        builder: (context, _) {
          final m = widget.markup;
          Offset rel(Offset p) => toRel(p, Offset.zero & content.size);
          return Stack(
            children: [
              Positioned.fromRect(rect: content, child: widget.child),
              Positioned.fromRect(
                rect: content,
                child: GestureDetector(
                  key: const ValueKey('markup-surface'),
                  behavior: HitTestBehavior.opaque,
                  // a shape starts where the finger went down, not where the drag was recognised
                  dragStartBehavior: DragStartBehavior.down,
                  onPanStart: m.marking
                      ? (d) => setState(() {
                          _a = _b = rel(d.localPosition);
                          _pen
                            ..clear()
                            ..addAll([_a!.dx, _a!.dy]);
                        })
                      : null,
                  onPanUpdate: m.marking
                      ? (d) => setState(() {
                          _b = rel(d.localPosition);
                          _pen.addAll([_b!.dx, _b!.dy]);
                        })
                      : null,
                  onPanEnd: m.marking
                      ? (_) {
                          final s = _live;
                          setState(() => _a = _b = null);
                          if (s != null) m.add(s);
                        }
                      : null,
                  child: CustomPaint(
                    painter: _MarksPainter(
                      shown: widget.shown,
                      draft: [...m.shapes, ?_live],
                      dim: m.marking,
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      );
    },
  );
}

class _MarksPainter extends CustomPainter {
  _MarksPainter({required this.shown, required this.draft, required this.dim});
  final List<ShownMark> shown;
  final List<MediaShape> draft;
  final bool dim;

  @override
  void paint(Canvas canvas, Size size) {
    const lw =
        2.5; // on the screen; the files get the desktop's width at the natural size
    for (final s in shown) {
      canvas.saveLayer(
        Offset.zero & size,
        Paint()..color = Color.fromRGBO(0, 0, 0, dim || s.sent ? 0.45 : 1),
      );
      paintShapes(canvas, s.shapes, size.width, size.height, lineWidth: lw);
      canvas.restore();
      _badge(canvas, size, s);
    }
    paintShapes(canvas, draft, size.width, size.height, lineWidth: lw);
  }

  void _badge(Canvas canvas, Size size, ShownMark s) {
    var x = 1.0, y = 1.0;
    for (final sh in s.shapes) {
      final (sx, sy) = switch (sh) {
        MediaShapeRectOrEllipse(:final x, :final y) => (x, y),
        MediaShapeArrow(:final x1, :final y1) => (x1, y1),
        MediaShapePen(:final points) when points.length >= 2 => (
          points[0],
          points[1],
        ),
        _ => (1.0, 1.0),
      };
      x = math.min(x, sx.toDouble());
      y = math.min(y, sy.toDouble());
    }
    final at = Offset(x * size.width, y * size.height);
    canvas.drawCircle(at, 10, Paint()..color = const Color(0xdd000000));
    final tp = TextPainter(
      text: TextSpan(
        text: '${s.n}',
        style: const TextStyle(color: Color(0xffffffff), fontSize: 12),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, at - Offset(tp.width / 2, tp.height / 2));
  }

  @override
  bool shouldRepaint(_MarksPainter old) => true;
}

/// While marking: the tools, the colours, undo, Comment and stop.
class MarkupToolbar extends StatelessWidget {
  const MarkupToolbar({
    super.key,
    required this.markup,
    required this.busy,
    required this.onComment,
  });

  final Markup markup;
  final bool busy;
  final VoidCallback onComment;

  @override
  Widget build(BuildContext context) {
    final t = AppLocalizations.of(context);
    return ListenableBuilder(
      listenable: markup,
      builder: (context, _) {
        final m = markup;
        Widget tool(MarkTool k, IconData icon, String tip) => IconButton(
          tooltip: tip,
          isSelected: m.tool == k,
          icon: Icon(icon),
          onPressed: busy ? null : () => m.tool = k,
        );
        // undo, close and Comment fill what the tools leave; the label shows only when it fits, else the icon alone
        Widget actions(BuildContext context, BoxConstraints box) {
          final label = MediaQuery.textScalerOf(
            context,
          ).scale(Theme.of(context).textTheme.labelLarge!.fontSize!);
          final fits = box.maxWidth >= 2 * 40 + 64 + label * 7;
          final onTap = m.shapes.isEmpty ? null : onComment;
          return Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              IconButton(
                tooltip: t.markUndo,
                icon: const Icon(Icons.undo),
                onPressed: busy || m.shapes.isEmpty ? null : m.undo,
              ),
              IconButton(
                tooltip: t.markStop,
                icon: const Icon(Icons.close),
                onPressed: busy ? null : () => m.marking = false,
              ),
              if (busy)
                const Padding(
                  padding: EdgeInsets.all(12),
                  child: SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              else if (fits)
                FilledButton.icon(
                  key: const ValueKey('markup-comment'),
                  icon: const Icon(Icons.add_comment_outlined),
                  label: Text(
                    t.comment,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onPressed: onTap,
                )
              else
                IconButton.filled(
                  key: const ValueKey('markup-comment'),
                  tooltip: t.comment,
                  icon: const Icon(Icons.add_comment_outlined),
                  onPressed: onTap,
                ),
            ],
          );
        }

        return Material(
          elevation: 4,
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Theme(
                    // 40 dp buttons: seven of them must fit 320 dp; the colours below keep the full 48
                    data: Theme.of(context).copyWith(
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: Row(
                      children: [
                        tool(MarkTool.rect, Icons.crop_square, t.toolRect),
                        tool(
                          MarkTool.ellipse,
                          Icons.circle_outlined,
                          t.toolEllipse,
                        ),
                        tool(MarkTool.pen, Icons.gesture, t.toolPen),
                        tool(MarkTool.arrow, Icons.north_east, t.toolArrow),
                        Expanded(child: LayoutBuilder(builder: actions)),
                      ],
                    ),
                  ),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      for (final (i, c) in markColors.indexed)
                        IconButton(
                          tooltip: t.markColor(i + 1),
                          constraints: const BoxConstraints.tightFor(
                            width: 48,
                            height: 48,
                          ),
                          onPressed: busy ? null : () => m.color = c,
                          icon: Container(
                            width: 20,
                            height: 20,
                            decoration: BoxDecoration(
                              color: colorOf(c),
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: m.color == c
                                    ? Theme.of(context).colorScheme.primary
                                    : Colors.black45,
                                width: m.color == c ? 3 : 1,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
