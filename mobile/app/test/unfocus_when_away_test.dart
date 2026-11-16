import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/ui/unfocus_when_away.dart';

// Android brings a focused field's keyboard back with a stale height when the app returns: the layout keeps the
// keyboard's room with no keyboard on screen. Leaving the screen drops the focus, so there is nothing to bring back.
void main() {
  Future<FocusNode> focused(WidgetTester t) async {
    final node = FocusNode();
    addTearDown(node.dispose);
    await t.pumpWidget(
      UnfocusWhenAway(
        child: MaterialApp(
          home: Scaffold(body: TextField(focusNode: node)),
        ),
      ),
    );
    await t.tap(find.byType(TextField));
    await t.pump();
    expect(node.hasFocus, isTrue);
    return node;
  }

  testWidgets('the field loses focus when the app leaves the screen', (
    t,
  ) async {
    final node = await focused(t);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await t.pump();
    expect(node.hasFocus, isFalse);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  });

  testWidgets('back on screen, the field gets its focus and keyboard again', (
    t,
  ) async {
    final node = await focused(t);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await t.pump();
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pump();
    expect(node.hasFocus, isTrue);
  });

  testWidgets(
    'a moment away from focus, such as the notification shade, keeps it',
    (t) async {
      final node = await focused(t);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await t.pump();
      expect(node.hasFocus, isTrue);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    },
  );
}
