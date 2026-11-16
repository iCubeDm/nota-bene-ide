import 'package:flutter/widgets.dart';

/// Drops the focus when the app leaves the screen. Android hides the keyboard while the app is away and, when it comes
/// back with a field still focused, restores that keyboard with its old height and no keyboard on screen: the layout
/// keeps the keyboard's room (the composer floats mid-screen, a sheet's bottom slips under the navigation bar).
/// Nothing focused, nothing is restored. A moment of `inactive` (the notification shade) keeps the focus.
class UnfocusWhenAway extends StatefulWidget {
  const UnfocusWhenAway({super.key, required this.child});
  final Widget child;

  @override
  State<UnfocusWhenAway> createState() => _UnfocusWhenAwayState();
}

class _UnfocusWhenAwayState extends State<UnfocusWhenAway> {
  late final AppLifecycleListener _life = AppLifecycleListener(
    onHide: () => FocusManager.instance.primaryFocus?.unfocus(),
  );

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
