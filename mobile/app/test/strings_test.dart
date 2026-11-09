import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/comments/strings.g.dart';
import 'package:nb_protocol/nb_protocol.dart';

void main() {
  test('the quick labels are the web\'s, in its order', () {
    expect(
      quickLabels.map((l) => l.id),
      QuickLabelId.values.where((v) => v != QuickLabelId.$unknown),
    );
    final fire = quickLabels.firstWhere((l) => l.id == QuickLabelId.fire);
    expect(fire.emoji, '🔥');
    expect(fire.instruction, startsWith('I really like this'));
    expect(
      quickLabels.first.instruction,
      isNull,
      reason: 'looks-good has none',
    );
  });

  test('label texts and the batch heading in every app language', () {
    final ru = File('../../web/src/i18n/ru.ts').readAsStringSync();
    expect(
      ru,
      contains("'label_looks-good': '${quickLabels.first.text['ru']}'"),
    );
    for (final lang in ['en', 'ru', 'zh', 'es', 'pt', 'de']) {
      for (final l in quickLabels) {
        expect(l.text[lang], isNotEmpty, reason: '${l.id} $lang');
      }
      expect(batchString('batchHead', lang), isNotEmpty);
    }
    expect(batchString('batchHead', 'ru'), 'Комментарии к фрагментам:');
    expect(batchString('batchHead', 'xx'), 'Comments on fragments:');
  });
}
