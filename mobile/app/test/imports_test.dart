// The leaks the reviews of issues 511 and 565 found, kept cut: the app's entry point is imported by nothing, the model
// and store files reach no screen, sheet, the voice player or the media renderer, not even through the files they
// import, and the stores import nothing above them.
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

  test(
    'model and store files reach no screen, sheet, voice player or renderer, also through what they import',
    () {
      bool model(String p) =>
          p.startsWith('store/') ||
          p.startsWith('notify/') ||
          (p.startsWith('chat/window_') && !p.endsWith('_sheet.dart')) ||
          p == 'sdk.dart' ||
          const {
            'chat/agent_connection.dart',
            'chat/feed.dart',
            'chat/session_state.dart',
            'comments/comments.dart',
            'comments/queue.dart',
            'voice/outbox.dart',
          }.contains(p);
      bool ui(String p) =>
          p.endsWith('_screen.dart') ||
          p.endsWith('_sheet.dart') ||
          p == 'voice/player.dart' ||
          p == 'media/render.dart';
      final bad = [
        for (final f in _lib(model))
          for (final path in _reach(f.path.substring(4)))
            if (ui(path.last)) path.join(' -> '),
      ];
      expect(bad, isEmpty);
    },
  );

  test('the stores import only stores, the theme ids and the host links', () {
    const above = {'../theme.dart', '../hosts/host_link.dart'};
    final bad = [
      for (final f in _lib((p) => p.startsWith('store/')))
        for (final i in _imports(f))
          if (!i.contains(':') && i.startsWith('../') && !above.contains(i))
            '${f.path}: $i',
    ];
    expect(bad, isEmpty);
  });

  test('the reach follows imports, also up a folder and two hops away', () {
    final r = _reach('chat/window_tab.dart').map((p) => p.last).toSet();
    expect(r, containsAll(['chat/agent_connection.dart', 'sdk.dart']));
    expect(
      r,
      contains('comments/queue.dart'),
      reason: 'through comments/comments.dart',
    );
  });
}

/// The lib/ files [from] (a path from lib/) reaches through its imports and exports, each as the chain that first got
/// there.
List<List<String>> _reach(String from) {
  final seen = <String>{from};
  final out = <List<String>>[];
  final queue = [
    [from],
  ];
  while (queue.isNotEmpty) {
    final chain = queue.removeAt(0);
    final at = chain.last;
    final file = File('lib/$at');
    if (!file.existsSync()) continue;
    for (final i in _imports(file)) {
      final String? next;
      if (i.startsWith('package:nb_app/')) {
        next = i.substring('package:nb_app/'.length);
      } else if (i.contains(':')) {
        next = null;
      } else {
        next = Uri.parse(at).resolve(i).path;
      }
      if (next == null || !seen.add(next)) continue;
      final c = [...chain, next];
      out.add(c);
      queue.add(c);
    }
  }
  return out;
}
