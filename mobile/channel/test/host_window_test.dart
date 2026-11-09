import 'package:nb_channel/nb_channel.dart';
import 'package:test/test.dart';

void main() {
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
}
