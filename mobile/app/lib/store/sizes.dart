// Text size and interface size (Settings), kept in the vault like the theme. Text size multiplies the phone's own font
// size; interface size scales the whole UI (text, icons, paddings), so touch targets grow with it.
import 'dart:ui' show DisplayFeature;

import 'package:flutter/widgets.dart';

import 'vault.dart';

/// Text size, as a multiple of the phone's font size: 85 % to 150 % in steps of 5.
const textSizes = <double>[
  0.85,
  0.9,
  0.95,
  1.0,
  1.05,
  1.1,
  1.15,
  1.2,
  1.25,
  1.3,
  1.35,
  1.4,
  1.45,
  1.5, //
];

/// Interface size choices.
const interfaceSizes = <double>[0.9, 1.0, 1.15, 1.3];

/// A size shown as a percent: 1.15 is "115 %".
String percent(double s) => '${(s * 100).round()} %';

class Sizes extends ChangeNotifier {
  Sizes._(this._vault, this._text, this._ui);

  static const _textKey = 'textSize', _uiKey = 'interfaceSize';

  static Future<Sizes> load(Vault v) async {
    double pick(String? s, List<double> from) =>
        from.firstWhere((x) => x.toString() == s, orElse: () => 1.0);
    return Sizes._(
      v,
      pick(await v.read(_textKey), textSizes),
      pick(await v.read(_uiKey), interfaceSizes),
    );
  }

  final Vault _vault;
  double _text, _ui;

  /// Multiplies the phone's text scale; 1 is the phone's own.
  double get text => _text;

  /// Scales the whole interface; 1 is the layout as designed.
  double get interface => _ui;

  /// Applies a text size at once; [keep] false leaves it unwritten (a slider being dragged: [keepText] writes it).
  Future<void> chooseText(double s, {bool keep = true}) async {
    if (s != _text) {
      _text = s;
      notifyListeners();
    }
    if (keep) await keepText();
  }

  /// Writes the text size in use.
  Future<void> keepText() => _vault.write(_textKey, _text.toString());

  Future<void> chooseInterface(double s) async {
    if (s == _ui) return;
    _ui = s;
    notifyListeners();
    await _vault.write(_uiKey, s.toString());
  }
}

/// A text scaler that multiplies another (the phone's, which may not be linear) by [k].
class MultipliedScaler extends TextScaler {
  const MultipliedScaler(this.base, this.k);
  final TextScaler base;
  final double k;

  @override
  double scale(double fontSize) => base.scale(fontSize) * k;

  @override
  // ignore: deprecated_member_use
  double get textScaleFactor => scale(14) / 14;

  @override
  bool operator ==(Object other) =>
      other is MultipliedScaler && other.base == base && other.k == k;

  @override
  int get hashCode => Object.hash(base, k);
}

/// Applies the sizes to everything below: the text scale on the phone's, and the interface scale as a layout at
/// (screen / s) painted s times larger, with a MediaQuery to match (safe areas, the keyboard inset and gestures
/// shrink by s, the pixel ratio grows by s). Hit testing goes through the transform, so touches land on what is shown.
class SizesScope extends StatelessWidget {
  const SizesScope({super.key, required this.sizes, required this.child});
  final Sizes? sizes;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final z = sizes;
    if (z == null) return child;
    return ListenableBuilder(
      listenable: z,
      builder: (context, _) {
        final mq = MediaQuery.of(context);
        final s = z.interface;
        final text = z.text == 1
            ? mq.textScaler
            : MultipliedScaler(mq.textScaler, z.text);
        EdgeInsets inset(EdgeInsets e) => e / s;
        final inner = mq.copyWith(
          size: mq.size / s,
          devicePixelRatio: mq.devicePixelRatio * s,
          textScaler: text,
          padding: inset(mq.padding),
          viewPadding: inset(mq.viewPadding),
          viewInsets: inset(mq.viewInsets),
          systemGestureInsets: inset(mq.systemGestureInsets),
          displayFeatures: [
            for (final f in mq.displayFeatures)
              DisplayFeature(
                bounds: Rect.fromLTRB(
                  f.bounds.left / s,
                  f.bounds.top / s,
                  f.bounds.right / s,
                  f.bounds.bottom / s,
                ),
                type: f.type,
                state: f.state,
              ),
          ],
        );
        // The same widgets at every size (also 100 %), so that changing the size keeps the state below: a layout at
        // screen / s that FittedBox paints s times larger. Hit testing goes through its transform, and the box is as
        // large as the screen, so a touch anywhere on it reaches the child.
        return ClipRect(
          child: FittedBox(
            fit: BoxFit.fill,
            alignment: Alignment.topLeft,
            child: _UiScale(
              s,
              child: SizedBox.fromSize(
                size: inner.size,
                child: MediaQuery(data: inner, child: child),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _UiScale extends InheritedWidget {
  const _UiScale(this.s, {required super.child});
  final double s;

  @override
  bool updateShouldNotify(_UiScale old) => s != old.s;
}

/// A screen (global) point in the interface's own units. Global positions are on the screen, but layout, [Positioned]
/// and [MediaQuery.size] below the scale are in the interface's units: a point is divided by the scale (a size read from
/// a render box already is in them).
Offset uiOffset(BuildContext context, Offset global) =>
    global / (context.getInheritedWidgetOfExactType<_UiScale>()?.s ?? 1);
