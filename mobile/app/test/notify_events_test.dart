import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/notify/events.dart';
import 'package:nb_app/store/notified.dart';
import 'package:nb_app/store/seen.dart';
import 'package:nb_app/store/vault.dart';
import 'package:nb_channel/nb_channel.dart';

const host = 'h1';

HostWindow win({
  String session = 's1',
  int? replies = 1,
  bool pending = false,
  String? title,
  LastMessage? last,
}) => HostWindow(
  port: 4791,
  provider: 'claude',
  root: '/home/u/notes',
  title: title,
  session: session,
  replies: replies,
  pending: pending,
  last: last,
);

void main() {
  late MemoryVault v;
  late Seen seen;
  late Notified notified;

  setUp(() async {
    v = MemoryVault();
    seen = await Seen.load(v);
    notified = await Notified.load(v);
  });

  /// What the app does with each window list: Seen records it first, then the events are taken.
  List<AgentEvent> list(
    List<HostWindow> ws, {
    bool Function(String, HostWindow)? onScreen,
  }) {
    seen.observe(host, ws);
    return detect(host, ws, seen, notified, onScreen: onScreen);
  }

  test(
    'a reply beyond the seen count is one event, the same list again is none',
    () {
      expect(list([win(replies: 1)]), isEmpty);
      final e = list([win(replies: 2)]);
      expect(e.single, isA<ReplyEvent>());
      expect(
        (e.single.hostId, e.single.session, e.single.port),
        (host, 's1', 4791),
      );
      expect(e.single.key, 'h1 s1');
      expect(list([win(replies: 2)]), isEmpty);
    },
  );

  test('a reply already seen on the phone is no event', () async {
    list([win(replies: 1)]);
    await seen.see(host, 's1', 2);
    expect(list([win(replies: 2)]), isEmpty);
  });

  test('a session first met is no reply event', () {
    expect(list([win(replies: 5)]), isEmpty);
  });

  test('a wait notifies once over many lists, again after it ended', () {
    list([win()]);
    expect(list([win(pending: true)]).single, isA<WaitEvent>());
    expect(list([win(pending: true)]), isEmpty);
    expect(list([win(pending: true)]), isEmpty);
    expect(list([win()]), isEmpty);
    expect(list([win(pending: true)]).single, isA<WaitEvent>());
  });

  test('a session first met already waiting notifies', () {
    expect(list([win(pending: true)]).single, isA<WaitEvent>());
  });

  test('the session on screen gives no event and does not notify later', () {
    list([win(replies: 1)]);
    bool here(String _, HostWindow _) => true;
    expect(list([win(replies: 2, pending: true)], onScreen: here), isEmpty);
    expect(list([win(replies: 2, pending: true)]), isEmpty);
  });

  test('a lower reply count (new history) notifies the next reply again', () {
    list([win(replies: 4)]);
    expect(list([win(replies: 5)]), hasLength(1));
    expect(list([win(replies: 1)]), isEmpty);
    expect(list([win(replies: 2)]).single, isA<ReplyEvent>());
  });

  test(
    'the reply text is the assistant\'s, cut to 120 characters; a user last message gives none',
    () {
      list([win(replies: 1)]);
      final long = 'x' * 200;
      final e =
          list([
                win(
                  replies: 2,
                  last: LastMessage(role: 'assistant', text: long),
                ),
              ]).single
              as ReplyEvent;
      expect(e.text!.length, lessThanOrEqualTo(121));
      expect(e.text, startsWith('x' * 100));
      final u =
          list([
                win(
                  replies: 3,
                  last: LastMessage(role: 'user', text: 'mine'),
                ),
              ]).single
              as ReplyEvent;
      expect(u.text, isNull);
    },
  );

  test('the project is the title, else the folder', () {
    expect(projectOf(win(title: 'Notes app')), 'Notes app');
    expect(projectOf(win()), 'notes');
  });

  test(
    'notified state survives reload; an unreadable slot starts empty',
    () async {
      list([win(replies: 1)]);
      list([win(replies: 2)]);
      final again = await Notified.load(v);
      // a fresh Seen that has the old count would see the reply as unread: notified keeps it from notifying twice
      final fresh = await Seen.load(MemoryVault());
      fresh.observe(host, [win(replies: 1)]);
      expect(detect(host, [win(replies: 2)], fresh, again), isEmpty);
      v.values['nb.notified'] = '{not json';
      final broken = await Notified.load(v);
      expect(detect(host, [win(pending: true)], fresh, broken), hasLength(1));
    },
  );
}
