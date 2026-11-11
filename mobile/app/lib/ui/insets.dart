import 'package:flutter/widgets.dart';

/// The room a scrolling page keeps under its last row: [base] and the navigation bar the page runs under (the app
/// draws edge to edge, so a list with its own padding no longer gets the bar's room for free).
double bottomRoom(BuildContext context, [double base = 16]) =>
    base + MediaQuery.paddingOf(context).bottom;
