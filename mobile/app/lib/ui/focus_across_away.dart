import 'package:flutter/widgets.dart';

/// Takes the focus away while the app is off the screen and gives it back on return. Android hides the keyboard while the app is away and, when it comes
/// back with a field still focused, restores that keyboard with its old height and no keyboard on screen: the layout
/// keeps the keyboard's room (the composer floats mid-screen, a sheet's bottom slips under the navigation bar).
/// Nothing focused, nothing is restored; back on screen the field takes the focus again and opens a fresh keyboard. A
/// moment of `inactive` (the notification shade) keeps the focus.
class FocusAcrossAway extends StatefulWidget {
  const FocusAcrossAway({super.key, required this.child});
  final Widget child;

  @override
  State<FocusAcrossAway> createState() => _FocusAcrossAwayState();
}

class _FocusAcrossAwayState extends State<FocusAcrossAway> {
  late final AppLifecycleListener _life = AppLifecycleListener(
    onHide: _hide,
    onResume: _resume,
  );

  /// The field that had the focus when the app left, given it back on return.
  FocusNode? _away;

  void _hide() {
    final node = FocusManager.instance.primaryFocus;
    if (node == null || node is FocusScopeNode) return;
    _away = node;
    node.unfocus();
  }

  void _resume() {
    final node = _away;
    _away = null;
    // gone with its screen, or the user already focused something else
    final free = FocusManager.instance.primaryFocus is FocusScopeNode;
    if (node != null && node.context != null && free) node.requestFocus();
  }

  @override
  void initState() {
    super.initState();
    _life;
  }

  @override
  void dispose() {
    _life.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
