import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

HostWindow win(String? session, int? replies) => HostWindow(
  port: 4791,
  provider: 'claude',
  root: '/home/u/notes',
  session: session,
  replies: replies,
);

void main() {
  late MemoryVault v;
  late Seen seen;

  setUp(() async {
    v = MemoryVault();
    seen = await Seen.load(v);
  });

  test('first sight is seen up to the current replies', () {
    expect(seen.unread('h', win('s1', 5)), 0);
    expect(seen.unread('h', win('s1', 7)), 2);
  });

  test('unread after replies grow, and see clears it', () async {
    seen.unread('h', win('s1', 1));
    expect(seen.unread('h', win('s1', 4)), 3);
    await seen.see('h', 's1', 4);
    expect(seen.seenOf('h', 's1'), 4);
    expect(seen.unread('h', win('s1', 4)), 0);
  });

  test('persists across a new instance', () async {
    seen.unread('h', win('s1', 1));
    await seen.see('h', 's1', 3);
    final again = await Seen.load(v);
    expect(again.seenOf('h', 's1'), 3);
    expect(again.unread('h', win('s1', 5)), 2);
  });

  test('a session id and a host have their own count', () async {
    await seen.see('h', 's1', 3);
    await seen.see('h', 's2', 1);
    await seen.see('g', 's1', 9);
    expect(seen.unread('h', win('s1', 4)), 1);
    expect(seen.unread('h', win('s2', 4)), 3);
    expect(seen.unread('g', win('s1', 4)), 0);
  });

  test('no session or no replies is not unread', () {
    expect(seen.unread('h', win(null, 5)), 0);
    expect(seen.unread('h', win('s1', null)), 0);
  });

  test(
    'replies that drop reset the stored count: later ones are unread',
    () async {
      await seen.see('h', 's1', 8);
      expect(seen.unread('h', win('s1', 2)), 0);
      expect(seen.seenOf('h', 's1'), 2);
      expect(seen.unread('h', win('s1', 3)), 1);
      final again = await Seen.load(v);
      expect(again.seenOf('h', 's1'), 2);
    },
  );

  test('a stored value is kept while the window is offline', () async {
    await seen.see('h', 's1', 6);
    final again = await Seen.load(v);
    expect(again.unread('h', win('s1', 6)), 0);
  });

  test('unreadable storage starts empty', () async {
    v.values['nb.seen'] = 'not json';
    final s = await Seen.load(v);
    expect(s.seenOf('h', 's1'), 0);
  });
}
