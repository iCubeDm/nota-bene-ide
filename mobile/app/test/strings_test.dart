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

  test('the batch\'s functions as templates, in every app language', () {
    expect(
      batchTemplate('imgLabelC', 'ru', [3, 2]),
      '[изображение 3 · к комментарию 2]',
    );
    expect(
      batchTemplate('imgRefMedia', 'en', [4]),
      '📎 images: 4 (frame with marks)',
    );
    expect(batchTemplate('filesLine', 'de', ['a, b']), '   Dateien: a, b');
    for (final lang in ['en', 'ru', 'zh', 'es', 'pt', 'de']) {
      for (final k in [
        'imgLabel',
        'imgLabelC',
        'imgRef',
        'imgRefMedia',
        'filesLine',
        'scaledSfx',
      ]) {
        expect(batchString(k, lang), contains('{0}'), reason: '$k $lang');
      }
      expect(batchString('markStale', lang), isNotEmpty);
    }
  });

  test('the usage words are the web\'s, in every app language', () {
    final files = {
      'en': 'en',
      'ru': 'ru',
      'zh': 'zh-CN',
      'es': 'es',
      'pt': 'pt-BR',
      'de': 'de',
    };
    for (final MapEntry(key: lang, value: file) in files.entries) {
      final src = File('../../web/src/i18n/$file.ts').readAsStringSync();
      final reset = RegExp(
        r"^  usageReset: '(.*)',$",
        multiLine: true,
      ).firstMatch(src)![1];
      expect(usageString('usageReset', lang), reset, reason: lang);
      final all = RegExp(
        r'^  usageShowAll: \(n: number\) => `(.*)`,$',
        multiLine: true,
      ).firstMatch(src)![1]!;
      expect(
        usageTemplate('usageShowAll', lang, [7]),
        all.replaceAll(r'${n}', '7'),
        reason: lang,
      );
    }
    expect(usageString('usageReset', 'xx'), 'Reset');
    expect(
      usageTemplate('usageExtraOf', 'en', ['\$1', '\$5']),
      'This billing period: \$1 of \$5.',
    );
  });
}
