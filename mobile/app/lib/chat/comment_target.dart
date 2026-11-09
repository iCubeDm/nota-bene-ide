// The message a piece of the chat belongs to, handed down to what a person may comment from inside it (a code block
// opened full screen). Only a commentable message provides one.
import 'package:flutter/widgets.dart';

import 'feed.dart';
import 'window_tab.dart';

class CommentTarget extends InheritedWidget {
  const CommentTarget({
    super.key,
    required this.tab,
    required this.item,
    required super.child,
  });

  final WindowTab tab;
  final FeedItem item;

  static CommentTarget? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<CommentTarget>();

  @override
  bool updateShouldNotify(CommentTarget old) =>
      tab != old.tab || item != old.item;
}
