import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/attach_sheet.dart';
import 'package:nb_app/main.dart';
import 'package:nb_app/media/picker.dart';
import 'package:nb_app/ui/nb_icon.dart';

void main() {
  testWidgets('the sheet offers camera, gallery and file with the web glyphs', (
    t,
  ) async {
    PickSource? got;
    await t.pumpWidget(
      NbApp(
        home: Builder(
          builder: (c) => TextButton(
            onPressed: () async => got = await showAttachSheet(c),
            child: const Text('go'),
          ),
        ),
      ),
    );
    await t.tap(find.text('go'));
    await t.pumpAndSettle();
    final glyphs = [
      for (final i in t.widgetList<NbIcon>(find.byType(NbIcon))) i.glyph,
    ];
    expect(glyphs, [NbGlyph.camera, NbGlyph.image, NbGlyph.file]);
    await t.tap(find.text('Gallery'));
    await t.pumpAndSettle();
    expect(got, PickSource.gallery);
  });
}
