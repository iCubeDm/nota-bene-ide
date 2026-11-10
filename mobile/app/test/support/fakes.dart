import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:nb_app/pairing/pair_flow.dart';
import 'package:nb_channel/nb_channel.dart';

/// A channel that never touches the network: windows come from [push], [close] ends it.
class FakeChannel implements Channel {
  FakeChannel([List<HostWindow>? initial, this.hostName]) {
    if (initial != null) push(initial);
  }

  @override
  final String? hostName;

  /// How many times the phone asked for the windows again; each answers with the current list, or fails when
  /// [refreshFails] is set.
  var refreshes = 0;
  bool refreshFails = false;
  Completer<void>? refreshGate;

  @override
  Future<List<HostWindow>> refreshWindows({
    Duration wait = const Duration(seconds: 10),
  }) async {
    refreshes++;
    await refreshGate?.future;
    if (refreshFails) throw TimeoutException('no answer');
    return _last ?? const [];
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

  /// Every HTTP request with its headers and body, in order.
  final calls =
      <
        ({
          String method,
          String path,
          Map<String, String> headers,
          List<int> body,
        })
      >[];

  @override
  Future<HttpAnswer> http(
    int port,
    String method,
    String path, {
    Map<String, String>? headers,
    List<int>? body,
  }) async {
    requests.add('$method $path');
    calls.add((
      method: method,
      path: path,
      headers: headers ?? const {},
      body: body ?? const [],
    ));
    final f = onHttp;
    if (f == null) throw StreamClosed(1000);
    return f(port, method, path);
  }

  /// Answers [httpStream] itself (a chunked body, say); none set: the [onHttp] answer as one chunk.
  Future<HttpStreamAnswer> Function(int port, String method, String path)?
  onHttpStream;

  /// How many streamed answers the phone cancelled.
  var cancels = 0;

  @override
  Future<HttpStreamAnswer> httpStream(
    int port,
    String method,
    String path, {
    Map<String, String>? headers,
    List<int>? body,
  }) async {
    final s = onHttpStream;
    if (s != null) {
      requests.add('$method $path');
      return s(port, method, path);
    }
    final a = await http(port, method, path, headers: headers, body: body);
    return (
      status: a.status,
      headers: a.headers,
      body: Stream.value(a.body),
      cancel: () => cancels++,
    );
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
        if (r is Future<Channel>) return r; // a connect that is still under way
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
