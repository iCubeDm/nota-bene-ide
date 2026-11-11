// A row that a swipe to the left carries away (the delete of a pending comment). Unlike Dismissible, only a leftward
// drag is claimed: a rightward one is let go to the PageView, so that the pane can still be swiped back to Chat.
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

class SwipeDelete extends StatefulWidget {
  const SwipeDelete({
    super.key,
    required this.background,
    required this.onDeleted,
    required this.child,
  });

  /// What shows behind the row as it moves.
  final Widget background;
  final VoidCallback onDeleted;
  final Widget child;

  @override
  State<SwipeDelete> createState() => _SwipeDeleteState();
}

/// A horizontal drag that gives way as soon as the finger goes right.
class _LeftDrag extends HorizontalDragGestureRecognizer {
  Offset? _from;

  @override
  void addAllowedPointer(PointerDownEvent event) {
    _from = event.position;
    super.addAllowedPointer(event);
  }

  @override
  void handleEvent(PointerEvent event) {
    final from = _from;
    if (event is PointerMoveEvent &&
        from != null &&
        event.position.dx - from.dx > 4) {
      resolve(GestureDisposition.rejected);
      stopTrackingPointer(event.pointer);
      return;
    }
    super.handleEvent(event);
  }
}

class _SwipeDeleteState extends State<SwipeDelete>
    with SingleTickerProviderStateMixin {
  late final _move = AnimationController(vsync: this);
  double _x = 0;
  double _width = 0;

  @override
  void dispose() {
    _move.dispose();
    super.dispose();
  }

  void _update(DragUpdateDetails d) {
    _move.stop();
    setState(() => _x = (_x + d.delta.dx).clamp(-_width, 0.0));
  }

  void _end(DragEndDetails d) {
    final gone = _x < -_width * .4 || d.velocity.pixelsPerSecond.dx < -700;
    final from = _x, to = gone ? -_width : 0.0;
    _move.duration = const Duration(milliseconds: 150);
    void tick() => setState(() => _x = from + (to - from) * _move.value);
    _move
      ..removeListener(tick)
      ..addListener(tick);
    _move.forward(from: 0).whenComplete(() {
      _move.removeListener(tick);
      if (gone && mounted) widget.onDeleted();
    });
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      _width = box.maxWidth;
      return RawGestureDetector(
        gestures: {
          _LeftDrag: GestureRecognizerFactoryWithHandlers<_LeftDrag>(
            _LeftDrag.new,
            (r) => r
              ..onUpdate = _update
              ..onEnd = _end,
          ),
        },
        child: Stack(
          // the row keeps the list's width
          fit: StackFit.passthrough,
          children: [
            if (_x < 0) Positioned.fill(child: widget.background),
            Transform.translate(offset: Offset(_x, 0), child: widget.child),
          ],
        ),
      );
    },
  );
}
