// A pinch that scales what [builder] draws (a text size), between [min] and [max]. The pointers are only watched, never
// claimed, so scrolling and selecting inside go on as they were.
import 'package:flutter/widgets.dart';

class PinchScale extends StatefulWidget {
  const PinchScale({
    super.key,
    required this.builder,
    this.min = 0.5,
    this.max = 3,
  });
  final Widget Function(BuildContext context, double scale) builder;
  final double min, max;

  @override
  State<PinchScale> createState() => _PinchScaleState();
}

class _PinchScaleState extends State<PinchScale> {
  double _scale = 1;
  final _fingers = <int, Offset>{};
  double _span0 = 0, _scale0 = 1;

  double get _span => (_fingers.values.first - _fingers.values.last).distance;

  void _down(PointerDownEvent e) {
    _fingers[e.pointer] = e.position;
    if (_fingers.length == 2) {
      _span0 = _span;
      _scale0 = _scale;
    }
  }

  void _move(PointerMoveEvent e) {
    if (!_fingers.containsKey(e.pointer)) return;
    _fingers[e.pointer] = e.position;
    if (_fingers.length != 2 || _span0 <= 0) return;
    setState(
      () => _scale = (_scale0 * _span / _span0).clamp(widget.min, widget.max),
    );
  }

  void _up(PointerEvent e) {
    _fingers.remove(e.pointer);
    _span0 = 0;
  }

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: _down,
    onPointerMove: _move,
    onPointerUp: _up,
    onPointerCancel: _up,
    child: widget.builder(context, _scale),
  );
}
