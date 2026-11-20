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
      expect(batchString(BatchKey.batchHead, lang), isNotEmpty);
    }
    expect(batchString(BatchKey.batchHead, 'ru'), 'Комментарии к фрагментам:');
    expect(batchString(BatchKey.batchHead, 'xx'), 'Comments on fragments:');
  });

  test('the batch\'s functions as templates, in every app language', () {
    expect(
      batchTemplate(BatchKey.imgLabelC, 'ru', [3, 2]),
      '[изображение 3 · к комментарию 2]',
    );
    expect(
      batchTemplate(BatchKey.imgRefMedia, 'en', [4]),
      '📎 images: 4 (frame with marks)',
    );
    expect(
      batchTemplate(BatchKey.filesLine, 'de', ['a, b']),
      '   Dateien: a, b',
    );
    for (final lang in ['en', 'ru', 'zh', 'es', 'pt', 'de']) {
      for (final k in [
        BatchKey.imgLabel,
        BatchKey.imgLabelC,
        BatchKey.imgRef,
        BatchKey.imgRefMedia,
        BatchKey.filesLine,
        BatchKey.scaledSfx,
      ]) {
        expect(batchString(k, lang), contains('{0}'), reason: '$k $lang');
      }
      expect(batchString(BatchKey.markStale, lang), isNotEmpty);
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
      expect(usageString(UsageKey.usageReset, lang), reset, reason: lang);
      final all = RegExp(
        r'^  usageShowAll: \(n: number\) => `(.*)`,$',
        multiLine: true,
      ).firstMatch(src)![1]!;
      expect(
        usageTemplate(UsageKey.usageShowAll, lang, [7]),
        all.replaceAll(r'${n}', '7'),
        reason: lang,
      );
    }
    expect(usageString(UsageKey.usageReset, 'xx'), 'Reset');
    expect(
      usageTemplate(UsageKey.usageExtraOf, 'en', ['\$1', '\$5']),
      'This billing period: \$1 of \$5.',
    );
  });

  test('the web keys: working and offline in every app language', () {
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
      for (final k in [WebKey.working, WebKey.offline]) {
        final v = RegExp(
          '^  ${k.name}: \'(.*)\',\$',
          multiLine: true,
        ).firstMatch(src)![1];
        expect(webString(k, lang), v, reason: '$k $lang');
      }
    }
    expect(webString(WebKey.offline, 'xx'), 'no connection to the server…');
  });

  test('the mode and clear texts of the web in every app language', () {
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
      for (final (k, got) in [
        ('clearBtn', webString(WebKey.clearBtn, lang)),
        ('clearTitle', webString(WebKey.clearTitle, lang)),
        ('mode_plan', modeLabel(AgentMode.plan, lang)),
        ('mode_plan_desc', modeDescription(AgentMode.plan, lang)),
        ('mode_codex-workspace', modeLabel(AgentMode.codexWorkspace, lang)),
        ('mode_omp-ask_desc', modeDescription(AgentMode.ompAsk, lang)),
      ]) {
        final q = k.contains('-') ? '\'$k\'' : k;
        final v = RegExp(
          '^  $q: \'(.*)\',\$',
          multiLine: true,
        ).firstMatch(src)![1];
        expect(got, v, reason: '$k $lang');
      }
    }
    expect(
      webString(WebKey.clearBtn, 'de'),
      isNot(webString(WebKey.clearBtn, 'en')),
    );
    expect(modeLabel(AgentMode.auto, 'xx'), modeLabel(AgentMode.auto, 'en'));
  });

  test('every mode has a name and a description in every app language', () {
    for (final lang in ['en', 'ru', 'zh', 'es', 'pt', 'de', 'xx']) {
      for (final m in AgentMode.values.where((m) => m != AgentMode.$unknown)) {
        expect(modeLabel(m, lang), isNotEmpty, reason: '$m $lang');
        expect(modeDescription(m, lang), isNotEmpty, reason: '$m $lang');
      }
    }
    // a mode from a newer host: no name, and no crash
    expect(modeLabel(AgentMode.$unknown, 'en'), '');
  });

  test('the counted strings follow the web\'s plural rule', () {
    String ru(int n) => webCount(CountKey.nComments, 'ru', n);
    expect(ru(1), '1 комментарий');
    expect(ru(3), '3 комментария');
    expect(ru(5), '5 комментариев');
    expect(ru(11), '11 комментариев');
    expect(ru(21), '21 комментарий');
    expect(ru(22), '22 комментария');
    expect(webCount(CountKey.nComments, 'en', 1), '1 comment');
    expect(webCount(CountKey.nComments, 'pt', 0), '0 comentários');
  });

  test('no lookup of the generated strings asserts it found something', () {
    final src = File('lib/comments/strings.g.dart').readAsStringSync();
    final code = src.substring(0, src.indexOf("const _json = r'''"));
    expect(code, isNot(contains(']!')));
  });
}
