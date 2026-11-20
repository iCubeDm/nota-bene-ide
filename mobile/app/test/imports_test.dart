// The two leaks the review of issue 511 found, kept cut: the app's entry point is imported by nothing, and the model and
// store files import no screen, sheet or the voice player.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The files under lib/ whose path (from lib/) [where] accepts.
List<File> _lib(bool Function(String path) where) => [
  for (final f in Directory('lib').listSync(recursive: true))
    if (f is File && f.path.endsWith('.dart') && where(f.path.substring(4))) f,
];

/// What [f] imports or exports, as written.
List<String> _imports(File f) => [
  for (final m in RegExp(
    r'''^(?:import|export)\s+['"]([^'"]+)['"]''',
    multiLine: true,
  ).allMatches(f.readAsStringSync()))
    m[1]!,
];

void main() {
  test('nothing in lib/ imports main.dart', () {
    final bad = [
      for (final f in _lib((p) => p != 'main.dart'))
        for (final i in _imports(f))
          if (i == 'package:nb_app/main.dart' ||
              i.endsWith('/main.dart') ||
              i == 'main.dart')
            '${f.path}: $i',
    ];
    expect(bad, isEmpty);
  });

  test('model and store files import no screen, sheet or voice player', () {
    bool model(String p) =>
        p.startsWith('store/') ||
        p.startsWith('notify/') ||
        p.startsWith('chat/window_') ||
        p == 'sdk.dart' ||
        const {
          'chat/feed.dart',
          'chat/session_state.dart',
          'comments/comments.dart',
          'comments/queue.dart',
          'voice/outbox.dart',
        }.contains(p);
    final bad = [
      for (final f in _lib(model))
        for (final i in _imports(f))
          if (i.endsWith('_screen.dart') ||
              i.endsWith('_sheet.dart') ||
              i.endsWith('voice/player.dart') ||
              (f.path.startsWith('lib/voice/') && i == 'player.dart'))
            '${f.path}: $i',
    ];
    expect(bad, isEmpty);
  });
}
