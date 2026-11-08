import 'dart:async';
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
  final opened = <Map<String, Object?>>[];

  void push(List<HostWindow> l) {
    _last = l;
    _ctl.add(l);
  }

  /// The relay or the network went away.
  void drop([int code = 1006]) {
    if (!_closed.isCompleted) _closed.complete(code);
    _ctl.close();
  }

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
