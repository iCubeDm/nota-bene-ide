import 'package:nb_channel/nb_channel.dart';
import 'package:test/test.dart';

Map<String, Object?> raw([Map<String, Object?> extra = const {}]) => {
  'port': 4781,
  'provider': 'claude',
  'root': '/proj',
  ...extra,
};

void main() {
  iconTests();
  test('a window reads its id, pending, last and replies', () {
    final w = HostWindow.fromJson(
      raw({
        'id': 'claude:0123456789abcdef',
        'pending': true,
        'last': {
          'role': 'assistant',
          'text': 'done **now**',
          'at': 1700000000000,
        },
        'replies': 3,
      }),
    );
    expect(w.key, 'claude:0123456789abcdef');
    expect(w.pending, isTrue);
    expect(w.replies, 3);
    expect(w.last!.role, LastMessageRole.assistant);
    expect(w.last!.text, 'done **now**');
    expect(w.last!.time, DateTime.fromMillisecondsSinceEpoch(1700000000000));
  });

  test('a host before ids (issue 511): the window is keyed by its port', () {
    final w = HostWindow.fromJson(raw());
    expect(w.id, isNull);
    expect(w.key, 'port:4781');
    expect(w.pending, isNull);
    expect(w.last, isNull);
    expect(w.replies, isNull);
    final n = HostWindow.fromJson(raw({'last': null, 'replies': 0}));
    expect(n.last, isNull);
    expect(n.replies, 0);
  });

  test('a last without a time (a restored history) has a null time', () {
    for (final at in [null, 0, -5]) {
      final w = HostWindow.fromJson(
        raw({
          'last': {'role': 'user', 'text': 'old', 'at': ?at},
        }),
      );
      expect(w.last!.text, 'old');
      expect(w.last!.time, isNull);
    }
  });

  test(
    'parseWindows: a window that does not parse is left out, the others kept',
    () {
      final list = parseWindows([
        raw({'pending': 'yes'}),
        'nonsense',
        raw({'port': 4782, 'last': 'nonsense'}),
        raw({'port': 4783, 'id': 'codex:x', 'provider': 'codex'}),
        {'port': 4784, 'provider': 'claude'}, // no root
      ], null);
      expect(list.map((w) => w.key), ['codex:x']);
    },
  );

  test(
    'an agent row keeps its agent through withIcon; at puts its paths under /a/<agent>',
    () {
      final w = HostWindow.fromJson(raw({'agent': 'claude-abcdef'}));
      expect(w.withIcon('v1').agent, 'claude-abcdef');
      expect(w.at('/ws?tab=1'), '/a/claude-abcdef/ws?tab=1');
      expect(HostWindow.fromJson(raw()).at('/info'), '/info');
    },
  );

  test(
    'a server\'s agents are rows of the one list, each with its agent id (epic 383)',
    () {
      final list = parseWindows([
        raw({'id': 'claude:a'}),
        raw({'id': 'claude:b', 'root': '/other', 'agent': 'claude-abcdef'}),
      ], null);
      expect(list.map((w) => (w.key, w.agent)), [
        ('claude:a', null),
        ('claude:b', 'claude-abcdef'),
      ]);
    },
  );

  test('parseWindows: an unknown agent is kept, as unknown', () {
    final list = parseWindows([
      raw({'provider': 'gemini'}),
    ], null);
    expect(list.single.provider, AgentProvider.$unknown);
  });
}

void iconTests() {
  test('icon: the version, null when none', () {
    expect(
      HostWindow.fromJson(raw({'icon': 'abcdef0123456789'})).icon,
      'abcdef0123456789',
    );
    expect(HostWindow.fromJson(raw({'icon': null})).icon, isNull);
  });

  test(
    'parseWindows: a window listed without icon keeps the last known one; a null removes it',
    () {
      final before = parseWindows([
        raw({'id': 'a', 'icon': 'v-keep'}),
      ], null);
      // the host could not read the window's /info that time: no field
      final kept = parseWindows([
        raw({'id': 'a'}),
      ], before);
      expect(kept.single.icon, 'v-keep');
      expect(
        parseWindows([
          raw({'id': 'a', 'icon': null}),
        ], kept).single.icon,
        isNull,
      );
      // another folder under that id is another window: nothing kept
      expect(
        parseWindows([
          raw({'id': 'a', 'root': '/other'}),
        ], before).single.icon,
        isNull,
      );
      // the same window on another port keeps it too
      expect(
        parseWindows([
          raw({'id': 'a', 'port': 4790}),
        ], before).single.icon,
        'v-keep',
      );
    },
  );
}
