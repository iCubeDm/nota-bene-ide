// The composer's draft is the window's, per session (issue 174): the rule of web/src/plugins/composer/draftSync.ts.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nb_app/chat/draft_sync.dart';
import 'package:nb_protocol/nb_protocol.dart';

const img = DraftImage(id: 'aaaa', mediaType: ImageType.image_png);

ServerEventDraft draft(
  String? sessionId,
  String text, {
  String? ack,
  List<DraftImage>? images,
}) => ServerEventDraft(
  sessionId: sessionId,
  text: text,
  ack: ack,
  images: images,
);

void main() {
  late List<ClientMessageDraft> writes;
  late bool online;
  late num? protocol;
  late DraftSync d;

  /// A sync whose throttle never ends on its own in a test: the trailing write goes by [DraftSync.flush].
  DraftSync make() => DraftSync(
    send: (m) {
      if (!online) return false;
      writes.add(m as ClientMessageDraft);
      return true;
    },
    has: (f) => has(protocol, f),
    throttle: const Duration(hours: 1),
  );

  /// Attached to session [sessionId]: its draft, then the hello, as the window sends them.
  void attach([String? sessionId = 's1']) {
    d.received(draft(sessionId, ''));
    protocol = 41;
    d.hello();
  }

  void type(String s) => d.text.text = s;

  setUp(() {
    writes = [];
    online = true;
    protocol = null;
    d = make();
  });

  tearDown(() => d.dispose());

  test(
    'a local edit is written at once, tagged with its session; its own echo leaves the text',
    () {
      attach();
      type('ab');
      expect(writes.single.toJson(), {
        'type': 'draft',
        'id': writes.single.id,
        'sessionId': 's1',
        'text': 'ab',
      });
      type('abc'); // typed since, inside the throttle
      d.received(draft('s1', 'ab', ack: writes.single.id));
      expect(d.text.text, 'abc');
      expect(writes, hasLength(1));
    },
  );

  test(
    'a foreign draft applies while clean, not over a pending or dirty one; a draft without ack ends the wait',
    () {
      attach();
      d.received(draft('s1', 'from the computer', ack: 'theirs'));
      expect(d.text.text, 'from the computer');
      type('mine');
      d.received(draft('s1', 'theirs again', ack: 'theirs2'));
      expect(d.text.text, 'mine');
      d.received(
        draft('s1', 'mine'),
      ); // a failed switch elsewhere: no ack is coming for the write
      d.received(draft('s1', 'later', ack: 'theirs3'));
      expect(d.text.text, 'later');
    },
  );

  test(
    'a scope change writes the dirty text to the old session and shows the new one',
    () {
      attach();
      type('half');
      type('half more'); // not written yet: the throttle holds it
      expect(writes.map((w) => w.text), ['half']);
      d.received(draft('s2', 'in s2'));
      expect((writes.last.sessionId, writes.last.text), ('s1', 'half more'));
      expect(d.text.text, 'in s2');
      d.received(draft('s2', 'computer in s2', ack: 'x'));
      expect(d.text.text, 'computer in s2');
    },
  );

  test(
    'an adoption keeps the keystrokes typed since the write that landed, and writes them under the new id',
    () {
      attach(null);
      type('a'); // written, tagged null: the window adopts it
      type('ab'); // held by the throttle
      d.received(
        draft('s1', 'a'),
      ); // the adoption's broadcast carries the adopted draft
      expect(d.text.text, 'ab');
      d.flush();
      expect((writes.last.sessionId, writes.last.text), ('s1', 'ab'));

      final clean = make();
      addTearDown(clean.dispose);
      clean.received(draft(null, ''));
      clean.received(draft('s9', 'the other session'));
      expect(clean.text.text, 'the other session');
    },
  );

  test(
    'reconcile at hello: a text typed before the attach draft wins, and so does one typed offline',
    () {
      type('typed early');
      d.received(draft('s1', 'stored'));
      expect(d.text.text, 'typed early');
      expect(writes, isEmpty, reason: 'nothing goes before the hello');
      protocol = 41;
      d.hello();
      expect(
        (writes.single.sessionId, writes.single.text),
        ('s1', 'typed early'),
      );

      d.flush();
      type('offline words'); // pending: lost with the socket
      d.closed();
      online = false;
      d.flush();
      online = true;
      d.received(draft('s1', 'typed early'));
      expect(d.text.text, 'offline words');
      d.hello();
      expect(
        (writes.last.sessionId, writes.last.text),
        ('s1', 'offline words'),
      );
    },
  );

  test('an oversized draft stays here, and survives a switch', () {
    attach();
    final big = 'x' * (draftMax + 1);
    type(big);
    d.flush();
    expect(writes, isEmpty);
    d.received(draft('s2', 'in s2'));
    expect(d.text.text, big);
    expect(writes, isEmpty);
  });

  test(
    'a foreign text is applied as the smallest change: the caret stays by its words',
    () {
      attach();
      d.received(draft('s1', 'hello world', ack: 'x'));
      expect(
        d.text.selection,
        const TextSelection.collapsed(offset: 11),
        reason: 'an empty field: the caret goes to the end',
      );
      d.text.selection = const TextSelection.collapsed(offset: 8); // wo|rld
      d.received(draft('s1', 'oh, hello world', ack: 'y'));
      expect(d.text.selection, const TextSelection.collapsed(offset: 12));
      d.received(draft('s1', 'oh, hello world!', ack: 'z'));
      expect(d.text.selection, const TextSelection.collapsed(offset: 12));
      expect(writes, isEmpty, reason: 'a foreign text is no local edit');
    },
  );

  test(
    'the pictures: a foreign draft replaces the uploaded ones and keeps an upload in flight; an upload is a local edit',
    () {
      attach();
      d.received(draft('s1', '', images: [img], ack: 'x'));
      expect(d.pictures.single.ref?.id, 'aaaa');
      expect(d.pictures.single.bytes, isNull, reason: 'shown from /attach');
      final mine = DraftPicture();
      d.add(mine);
      expect(
        writes,
        isEmpty,
        reason: 'an upload in flight is not in the draft',
      );
      d.received(draft('s1', '', ack: 'y'));
      expect(d.pictures, [mine]);
      mine.ref = const ImageRef(
        id: 'bbbb',
        mediaType: ImageType.image_png,
        label: '',
      );
      d.uploaded(mine);
      expect(writes.single.images?.map((i) => i.toJson()), [
        {'id': 'bbbb', 'mediaType': 'image/png'},
      ]);
      d.remove(mine);
      d.flush();
      expect(writes.last.images, isNull);
    },
  );

  test('a send clears the text and the sent images in one write', () {
    final eager = DraftSync(
      send: (m) {
        writes.add(m as ClientMessageDraft);
        return true;
      },
      has: (f) => has(41, f),
      throttle: Duration.zero,
    );
    addTearDown(eager.dispose);
    eager.received(draft('s1', ''));
    final p = DraftPicture(
      ref: const ImageRef(
        id: 'cccc',
        mediaType: ImageType.image_png,
        label: '',
      ),
    );
    eager.text.text = 'with a picture';
    eager.add(p);
    writes.clear();
    eager.sent([p]);
    expect(writes.single.toJson(), {
      'type': 'draft',
      'id': writes.single.id,
      'sessionId': 's1',
      'text': '',
    });
    expect(eager.text.text, '');
    expect(eager.pictures, isEmpty);
  });
}
