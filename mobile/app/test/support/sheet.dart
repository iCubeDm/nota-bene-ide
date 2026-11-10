import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Send in the field of the comment sheet (the sheet has no Save button).
Finder get sheetSend => find.descendant(
  of: find.byType(BottomSheet),
  matching: find.byKey(const ValueKey('send')),
);

/// Taps Send once the field has shown it (a typed text swaps the mic for it on the next frame).
Future<void> tapSend(WidgetTester t) async {
  await t.pump();
  await t.pump(const Duration(milliseconds: 300));
  await t.tap(sheetSend);
}

/// Saves a comment whose test cares only about its anchor: a comment needs a text (or a label, or a voice) to be sent,
/// so a bare sheet gets a short note first.
Future<void> sendNote(WidgetTester t) async {
  await t.pump(const Duration(milliseconds: 300));
  if (sheetSend.evaluate().isEmpty) {
    await t.enterText(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byType(TextField),
      ),
      'note',
    );
  }
  await tapSend(t);
}
