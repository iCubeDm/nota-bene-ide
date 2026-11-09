import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:nb_app/pairing/pair_flow.dart';
import 'package:nb_channel/nb_channel.dart';

/// A channel that never touches the network: windows come from [push], [close] ends it.
class FakeChannel implements Channel {
  FakeChannel([List<HostWindow>? initial]) {
    if (initial != null) push(initial);
  }

  final _ctl = StreamController<List<HostWindow>>.broadcast();
  final _closed = Completer<int>();
  List<HostWindow>? _last;

  /// Every frame the phone sent, decoded; the test plays the host with [host].
  final sent = <Frame>[];
  late final Mux mux = Mux((b) => sent.add(decodeFrame(b)));

  void host(Frame f) => mux.receive(encodeFrame(f));

  /// A server event on stream [id], as the window sends it.
  void event(int id, Map<String, Object?> e) =>
      host(Data(id, utf8.encode(jsonEncode(e)), fin: true));

  /// The OPEN bodies of ws streams, newest last.
  List<Map<String, Object?>> get wsOpens => [
    for (final f in sent)
      if (f is Open && (f.json as Map)['kind'] == 'ws')
        (f.json as Map).cast<String, Object?>(),
  ];

  /// The JSON messages the phone sent on stream [id].
  List<Map<String, Object?>> sentOn(int id) => [
    for (final f in sent)
      if (f is Data && f.stream == id && f.data.isNotEmpty)
        (jsonDecode(utf8.decode(f.data)) as Map).cast<String, Object?>(),
  ];

  int get lastWsId => sent
      .whereType<Open>()
      .where((f) => (f.json as Map)['kind'] == 'ws')
      .last
      .stream;

  void push(List<HostWindow> l) {
    _last = l;
    _ctl.add(l);
  }

  /// The relay or the network went away.
  void drop([int code = 1006]) {
    mux.closeAll(unreachable);
    if (!_closed.isCompleted) _closed.complete(code);
    _ctl.close();
  }

  @override
  MuxStream ws(int port, String path) =>
      mux.open({'kind': 'ws', 'port': port, 'path': path});

  @override
  Stream<List<HostWindow>> get windows async* {
    final l = _last;
    if (l != null) yield l;
    yield* _ctl.stream;
  }

  @override
  List<HostWindow>? get lastWindows => _last;

  @override
  Future<int> get closed => _closed.future;

  @override
  bool get isClosed => _closed.isCompleted;

  @override
  Future<void> close() async => drop(1000);

  /// Answers the phone's HTTP requests to windows; none set: the stream closes, as a host without the route does.
  Future<HttpAnswer> Function(int port, String method, String path)? onHttp;

  /// Every HTTP request the phone made: `METHOD path`.
  final requests = <String>[];

  @override
  Future<HttpAnswer> http(
    int port,
    String method,
    String path, {
    Map<String, String>? headers,
    List<int>? body,
  }) async {
    requests.add('$method $path');
    final f = onHttp;
    if (f == null) throw StreamClosed(1000);
    return f(port, method, path);
  }

  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

typedef Connect = ({
  Uri relay,
  Uint8List hostPub,
  Uint8List? ticket,
  Map<String, Object?> hello,
});

/// Records every connect and answers with the next of [results] (a [Channel] or an exception to throw).
class FakeFactory {
  final calls = <Connect>[];
  final results = <Object>[];

  ChannelFactory get factory =>
      ({
        required Uri relay,
        required Uint8List hostPub,
        required KeyPair key,
        Uint8List? ticket,
        Map<String, Object?> hello = const {'v': 1},
      }) async {
        calls.add((
          relay: relay,
          hostPub: hostPub,
          ticket: ticket,
          hello: hello,
        ));
        final r = results.isEmpty ? FakeChannel() : results.removeAt(0);
        if (r is Channel) return r;
        throw r;
      };
}

HttpAnswer answer(int status, String body, {Map<String, String>? headers}) => (
  status: status,
  headers: headers ?? const {},
  body: Uint8List.fromList(utf8.encode(body)),
);

HostWindow window(
  int port,
  String root, {
  String provider = 'claude',
  bool busy = false,
  String? title,
  String? model,
}) => HostWindow(
  port: port,
  provider: provider,
  root: root,
  busy: busy,
  title: title,
  model: model,
);
