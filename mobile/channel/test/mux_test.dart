import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:nb_channel/nb_channel.dart';
import 'package:test/test.dart';

String toHex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

/// The phone's Mux against a hand-driven host: every frame the phone sends lands in [sent].
class Wire {
  Wire({int maxMessage = maxCollect}) {
    mux = Mux((b) => sent.add(decodeFrame(b)), maxMessage: maxMessage);
  }
  late final Mux mux;
  final sent = <Frame>[];

  void host(Frame f) => mux.receive(encodeFrame(f));
  Iterable<T> of<T extends Frame>() => sent.whereType<T>();
}

Future<void> settle() => Future<void>.delayed(Duration.zero);

void main() {
  test('encodes the CHANNEL.md example', () {
    final f = Data(1, utf8.encode('hi'), fin: true);
    expect(
      toHex(encodeFrame(f)),
      '03000000010168'
      '69',
    );
    final back = decodeFrame(encodeFrame(f)) as Data;
    expect(
      (back.stream, back.fin, back.binary, utf8.decode(back.data)),
      (1, true, false, 'hi'),
    );
    expect(decodeFrame(encodeFrame(Credit(0, 7))), isA<Credit>());
    expect(() => decodeFrame(Uint8List(5)), throwsA(isA<MuxError>()));
    expect(
      () => decodeFrame(Uint8List.fromList([9, 0, 0, 0, 1, 0])),
      throwsA(isA<MuxError>()),
    );
  });

  test('opens odd ids from 1', () {
    final w = Wire();
    expect(w.mux.open({'kind': 'host'}).id, 1);
    expect(w.mux.open({'kind': 'host'}).id, 3);
    final o = w.of<Open>().first;
    expect(o.json, {'kind': 'host'});
  });

  test('a 1 MiB message crosses with credit', () async {
    // phone → host: the host grants as it consumes, the phone never runs ahead of the window
    final w = Wire();
    final s = w.mux.open({'kind': 'http'});
    final big = Uint8List.fromList(List.generate(1 << 20, (i) => i & 0xff));
    var done = false;
    s.send(big).then((_) => done = true);
    var granted = 0;
    while (!done) {
      await settle();
      final data = w.of<Data>().toList();
      final inFlight = data.fold<int>(0, (n, d) => n + d.data.length) - granted;
      expect(inFlight, lessThanOrEqualTo(streamWindow));
      for (final d in data) {
        expect(d.data.length, lessThanOrEqualTo(maxChunk));
      }
      final sum = data.fold<int>(0, (n, d) => n + d.data.length);
      if (sum - granted > 0) {
        final n = sum - granted;
        granted += n;
        w.host(Credit(s.id, n));
        w.host(Credit(0, n));
      }
    }
    final got = [for (final d in w.of<Data>()) ...d.data];
    expect(got.length, big.length);
    expect(got, big);
    expect(w.of<Data>().last.fin, isTrue);
    expect(w.of<Data>().where((d) => d.fin).length, 1);

    // host → phone: one message of 1 MiB reassembles, and the phone grants credit as it goes
    final r = w.mux.open({'kind': 'http'});
    final msgs = <Uint8List>[];
    r.messages.listen((m) => msgs.add(m.data));
    var hostCredit = streamWindow, connCredit = connWindow, off = 0;
    while (off < big.length) {
      final n = [
        maxChunk,
        big.length - off,
        hostCredit,
        connCredit,
      ].reduce((a, b) => a < b ? a : b);
      expect(n, greaterThan(0), reason: 'the phone stopped granting');
      w.host(Data(r.id, big.sublist(off, off + n), fin: off + n == big.length));
      off += n;
      hostCredit -= n;
      connCredit -= n;
      await settle();
      for (final c in w.sent.whereType<Credit>().toList()) {
        if (c.stream == r.id) hostCredit += c.n;
        if (c.stream == 0) connCredit += c.n;
      }
      w.sent.removeWhere((f) => f is Credit);
    }
    await settle();
    expect(msgs.single, big);
  });

  test('sending past the window is a protocol error', () async {
    final w = Wire();
    final a = w.mux.open({'kind': 'http'});
    final b = w.mux.open({'kind': 'http'});
    w.host(Data(a.id, Uint8List(streamWindow + 1)));
    expect((await a.closed).code, badFrame);
    expect((await b.closed).code, badFrame);
    expect(w.mux.failed, isTrue);
  });

  test('the 65th stream is refused with 4929', () async {
    final w = Wire();
    for (var i = 0; i < maxStreams; i++) {
      w.mux.open({'kind': 'host'});
    }
    final extra = w.mux.open({'kind': 'host'});
    expect((await extra.closed).code, tooMany);
    expect(w.of<Open>().length, maxStreams);
  });

  test('an empty message is one empty DATA with FIN', () async {
    final w = Wire();
    final s = w.mux.open({'kind': 'ws'});
    await s.send(const []);
    final d = w.of<Data>().single;
    expect((d.data.length, d.fin), (0, true));
    final got = <int>[];
    s.messages.listen((m) => got.add(m.data.length));
    w.host(Data(s.id, const [], fin: true));
    await settle();
    expect(got, [0]);
  });

  test('a binary message keeps its flag', () async {
    final w = Wire();
    final s = w.mux.open({'kind': 'ws'});
    await s.send([1, 2], binary: true);
    expect(w.of<Data>().single.binary, isTrue);
    final got = <bool>[];
    s.messages.listen((m) => got.add(m.binary));
    w.host(Data(s.id, const [3], fin: true, binary: true));
    await settle();
    expect(got, [true]);
  });

  test('a stream ended both ways closes with 1000', () async {
    final w = Wire();
    final s = w.mux.open({'kind': 'http'});
    final heads = <Map<String, Object?>>[];
    s.head.then(heads.add);
    s.end();
    expect(w.of<End>().single.stream, s.id);
    w.host(Head(s.id, {'status': 200}));
    w.host(End(s.id));
    expect((await s.closed).code, normalClose);
    expect(heads.single['status'], 200);
  });

  test('CLOSE from the host carries its code and reason', () async {
    final w = Wire();
    final s = w.mux.open({'kind': 'ws'});
    final msgs = s.messages.toList();
    w.host(Close(s.id, 4001, 'taken over'));
    final c = await s.closed;
    expect((c.code, c.reason), (4001, 'taken over'));
    expect(await msgs, isEmpty);
    await expectLater(s.head, throwsA(isA<StreamClosed>()));
  });

  test('a message beyond maxMessage closes with 4913', () async {
    final w = Wire(maxMessage: 10);
    final s = w.mux.open({'kind': 'http'});
    s.messages.listen((_) {});
    w.host(Data(s.id, Uint8List(6)));
    w.host(Data(s.id, Uint8List(6), fin: true));
    expect((await s.closed).code, tooLarge);
    expect(w.of<Close>().single.code, tooLarge);
  });

  test('a stream the host opens is refused', () async {
    final w = Wire();
    w.host(Open(2, {'kind': 'host'}));
    expect(w.of<Close>().single.code, badFrame);
  });

  test('closeAll ends every stream locally', () async {
    final w = Wire();
    final s = w.mux.open({'kind': 'ws'});
    w.mux.closeAll(unreachable);
    expect((await s.closed).code, unreachable);
    expect(w.of<Close>(), isEmpty);
  });

  test('a paused listener withholds credit until it resumes', () async {
    final w = Wire();
    final s = w.mux.open({'kind': 'ws'});
    final sub = s.messages.listen((_) {});
    sub.pause();
    for (var i = 0; i < 3; i++) {
      w.host(Data(s.id, Uint8List(maxChunk), fin: true));
    }
    await settle();
    expect(w.of<Credit>(), isEmpty);
    sub.resume();
    await settle();
    expect(
      w.of<Credit>().where((c) => c.stream == s.id).single.n,
      3 * maxChunk,
    );
    await sub.cancel();
  });
}
