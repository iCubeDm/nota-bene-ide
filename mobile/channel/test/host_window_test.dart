import 'package:nb_channel/nb_channel.dart';
import 'package:test/test.dart';

void main() {
  iconTests();
  test('a window reads its pending, last and replies', () {
    final w = HostWindow.fromJson({
      'port': 4781,
      'provider': 'claude',
      'root': '/proj',
      'pending': true,
      'last': {
        'role': 'assistant',
        'text': 'done **now**',
        'at': 1700000000000,
      },
      'replies': 3,
    });
    expect(w.pending, isTrue);
    expect(w.replies, 3);
    expect(w.last!.role, 'assistant');
    expect(w.last!.text, 'done **now**');
    expect(w.last!.at, DateTime.fromMillisecondsSinceEpoch(1700000000000));
  });

  test('an older window sends none of them: the defaults', () {
    final w = HostWindow.fromJson({
      'port': 4781,
      'provider': 'claude',
      'root': '/proj',
    });
    expect(w.pending, isFalse);
    expect(w.last, isNull);
    expect(w.replies, isNull);
    final n = HostWindow.fromJson({
      'port': 4781,
      'provider': 'claude',
      'root': '/proj',
      'last': null,
      'replies': 0,
    });
    expect(n.last, isNull);
    expect(n.replies, 0);
  });

  test('a last without a time (a restored history) has a null at', () {
    for (final at in [null, 0, -5]) {
      final w = HostWindow.fromJson({
        'port': 4781,
        'provider': 'claude',
        'root': '/proj',
        'last': {'role': 'user', 'text': 'old', 'at': ?at},
      });
      expect(w.last, isNotNull);
      expect(w.last!.text, 'old');
      expect(w.last!.at, isNull);
    }
  });

  test('replies as a whole double, malformed pending and last tolerated', () {
    final w = HostWindow.fromJson({
      'port': 4781,
      'provider': 'claude',
      'root': '/proj',
      'replies': 1.0,
      'pending': 'yes',
      'last': {'role': 'user', 'text': 5, 'at': 'now'},
    });
    expect(w.replies, 1);
    expect(w.pending, isFalse);
    expect(w.last, isNull);
    expect(
      HostWindow.fromJson({
        'port': 4781,
        'provider': 'claude',
        'root': '/proj',
        'last': 'nonsense',
        'replies': 'x',
      }).last,
      isNull,
    );
  });
}

void iconTests() {
  test(
    'icon: the version, null when none, and whether the host knows icons',
    () {
      HostWindow w(Map<String, Object?> extra) => HostWindow.fromJson({
        'port': 4781,
        'provider': 'claude',
        'root': '/proj',
        ...extra,
      });
      expect(w({'icon': 'abcdef0123456789'}).icon, 'abcdef0123456789');
      expect(w({'icon': 'abcdef0123456789'}).iconSupported, isTrue);
      expect(w({'icon': null}).icon, isNull);
      expect(w({'icon': null}).iconSupported, isTrue);
      // an older host sends no field at all
      expect(w({}).icon, isNull);
      expect(w({}).iconSupported, isFalse);
    },
  );
}
