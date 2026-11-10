// The phone's channel to one host (server/src/remote/CHANNEL.md): the relay's device admission (relay/PROTOCOL.md),
// the Noise IK handshake as the initiator with the host key pinned, then one mux frame per transport message.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'mux.dart';
import 'noise.dart';
import 'pairing.dart';

class ChannelError implements Exception {
  ChannelError(this.message, {this.relayCode});
  final String message;

  /// The relay's close code when it closed the connection (4403: not paired, or the pairing code is no longer valid).
  final int? relayCode;
  @override
  String toString() =>
      'ChannelError($message${relayCode == null ? '' : ', $relayCode'})';
}

/// One window as the host stream lists it.
/// The latest user message or final reply of a window's session, as the window sends it: one plain line.
class LastMessage {
  LastMessage({required this.role, required this.text, this.at});

  /// `user` or `assistant`.
  final String role, text;

  /// Null when the window has no time for it (a restored history).
  final DateTime? at;

  static LastMessage? fromJson(Object? j) {
    if (j is! Map) return null;
    final role = j['role'], text = j['text'], at = j['at'];
    if (role is! String || text is! String) return null;
    return LastMessage(
      role: role,
      text: text,
      at: at is num && at > 0
          ? DateTime.fromMillisecondsSinceEpoch(at.toInt())
          : null,
    );
  }
}

class HostWindow {
  HostWindow({
    required this.port,
    required this.provider,
    required this.root,
    this.title,
    this.session,
    this.model,
    this.busy = false,
    this.supervised = false,
    this.pending = false,
    this.last,
    this.replies,
  });

  factory HostWindow.fromJson(Map<String, Object?> j) => HostWindow(
    port: j['port'] as int,
    provider: j['provider'] as String,
    root: j['root'] as String,
    title: j['title'] as String?,
    session: j['session'] as String?,
    model: j['model'] as String?,
    busy: j['busy'] == true,
    supervised: j['supervised'] == true,
    pending: j['pending'] == true,
    last: LastMessage.fromJson(j['last']),
    replies: switch (j['replies']) {
      final num n => n.toInt(),
      _ => null,
    },
  );

  final int port;
  final String provider;
  final String root;
  final String? title, session, model;
  final bool busy, supervised;

  /// A permission or interaction prompt awaits an answer in the window.
  final bool pending;

  /// Null: no message yet, or an older window that does not tell.
  final LastMessage? last;

  /// The final replies of the session; null from an older window.
  final int? replies;
}

typedef HttpAnswer = ({
  int status,
  Map<String, String> headers,
  Uint8List body,
});

/// A response whose body is read as it arrives. [cancel] closes the stream (a body that is never read must be
/// cancelled, or its stream stays open).
typedef HttpStreamAnswer = ({
  int status,
  Map<String, String> headers,
  Stream<Uint8List> body,
  void Function() cancel,
});

/// The answer on an http stream [s] whose request has gone out: the head, then the body as it arrives. No credit is
/// granted while the body has no listener or its listener pauses, so a slow reader throttles the host. The body fails
/// with [StreamClosed] when the host breaks the stream off; cancelling its subscription closes the stream.
Future<HttpStreamAnswer> streamAnswer(MuxStream s) async {
  final head = await s.head;
  void cancel() {
    if (!s.isClosed) s.close(normalClose);
  }

  StreamSubscription<Message>? sub;
  late final StreamController<Uint8List> out;
  out = StreamController<Uint8List>(
    onListen: () {
      sub = s.messages.listen(
        (m) => out.add(m.data),
        onDone: () async {
          final c = await s.closed;
          if (c.code != normalClose) {
            out.addError(StreamClosed(c.code, c.reason));
          }
          await out.close();
        },
      );
    },
    onPause: () => sub?.pause(),
    onResume: () => sub?.resume(),
    onCancel: () {
      cancel(); // a reader that stopped early: the host stops too
      return sub?.cancel();
    },
  );

  final h = head['headers'];
  return (
    status: head['status'] as int,
    headers: {
      if (h is Map)
        for (final e in h.entries) '${e.key}': '${e.value}',
    },
    body: out.stream,
    cancel: cancel,
  );
}

/// Request headers the host passes on; the rest it drops, so they are not sent at all.
const passedHeaders = {
  'accept',
  'content-type',
  'range',
  'if-none-match',
  'if-range',
  'if-modified-since',
};

class Channel {
  Channel._(this._ws, this._tx, [this.hostName]);

  final WebSocketChannel _ws;
  final CipherState _tx;
  late final Mux _mux;
  late MuxStream _host;
  Future<void> _sending = Future.value();
  final _closed = Completer<int>();
  final _windows = StreamController<List<HostWindow>>.broadcast();
  List<HostWindow>? _last;

  /// What the host's computer calls itself (the welcome's `host`); null when the host sent none (an older host).
  final String? hostName;

  /// Admission, handshake and the host stream. Throws [ChannelError] when any of them fails.
  static Future<Channel> connect({
    required Uri relay,
    required Uint8List hostPub,
    required KeyPair key,
    Uint8List? ticket,
    Map<String, Object?> hello = const {'v': 1},
    Duration timeout = const Duration(seconds: 15),

    /// A relay that answers no ping within this long is dropped: after a network change or a sleep the socket can
    /// look alive for many minutes otherwise (the relay itself pings every 30 s).
    Duration pingInterval = const Duration(seconds: 25),
  }) async {
    final base = relay.toString().replaceAll(RegExp(r'/+$'), '');
    final WebSocketChannel ws = IOWebSocketChannel.connect(
      Uri.parse('$base/v1/device?host=${b64u(hostPub)}'),
      pingInterval: pingInterval,
      connectTimeout: timeout,
    );
    // a refused or failed connect also fails `ready`: the stream's onError reports it, this keeps it handled
    unawaited(ws.ready.catchError((Object _) {}));
    final hs = await Handshake.initiator(s: key, rs: hostPub);
    final ready = Completer<Channel>();
    Channel? ch;
    var rx = Future<void>.value();

    void fail(String message, {int? code}) {
      if (!ready.isCompleted) {
        ready.completeError(ChannelError(message, relayCode: code));
      }
      ws.sink.close();
    }

    Future<void> onMessage(Object? data) async {
      if (data is String) {
        final Object? m;
        try {
          m = jsonDecode(data);
        } on FormatException {
          return fail('the relay sent something unexpected');
        }
        if (m is! Map) return;
        if (m['t'] == 'challenge' && ch == null) {
          final proof = await relayProof(
            key.priv,
            fromB64u(m['eph'] as String, 32),
            fromB64u(m['nonce'] as String, 32),
          );
          ws.sink.add(
            jsonEncode({
              't': 'hello',
              'key': b64u(key.pub),
              'proof': b64u(proof),
              if (ticket != null) 'ticket': b64u(ticket),
            }),
          );
        } else if (m['t'] == 'ok' && ch == null && !hs.done) {
          ws.sink.add(await hs.writeMessage(utf8.encode(jsonEncode(hello))));
        }
        return;
      }
      final bytes = data is Uint8List
          ? data
          : Uint8List.fromList(data as List<int>);
      final c = ch;
      if (c == null) {
        final Object? welcome;
        try {
          welcome = jsonDecode(utf8.decode(await hs.readMessage(bytes)));
        } on Object {
          return fail('the host did not answer the handshake');
        }
        if (welcome is! Map || welcome['ok'] != true) {
          return fail('the host refused the handshake');
        }
        final keys = hs.split();
        final name = welcome['host'];
        final made = ch = Channel._(
          ws,
          keys.send,
          name is String && name.trim().isNotEmpty ? name.trim() : null,
        );
        made._start(keys.recv);
        ready.complete(made);
        return;
      }
      await c._receive(bytes);
    }

    ws.stream.listen(
      (data) => rx = rx.then((_) => onMessage(data)).catchError((Object e) {
        fail('$e');
      }),
      onError: (Object e) => fail('the relay could not be reached'),
      onDone: () {
        final code = ws.closeCode;
        if (!ready.isCompleted) {
          fail('the relay closed the connection', code: code);
        }
        ch?._ended(code ?? 0);
      },
      cancelOnError: false,
    );
    return ready.future.timeout(
      timeout,
      onTimeout: () {
        ws.sink.close();
        throw ChannelError('no answer from the relay or the host');
      },
    );
  }

  late CipherState _rx;

  void _start(CipherState recv) {
    _rx = recv;
    _mux = Mux(_sendFrame);
    _listenHost();
  }

  void _listenHost() {
    final stream = _host = _mux.open({'kind': 'host'});
    stream.messages.listen((m) {
      final Object? j;
      try {
        j = jsonDecode(utf8.decode(m.data));
      } on FormatException {
        return;
      }
      if (j is Map && j['t'] == 'windows' && j['windows'] is List) {
        final list = [
          for (final w in j['windows'] as List)
            if (w is Map) HostWindow.fromJson(w.cast<String, Object?>()),
        ];
        _last = list;
        _windows.add(list);
      }
    });
  }

  /// Asks the host for its windows again: the host stream is opened anew, and the host lists its windows when a host
  /// stream opens (CHANNEL.md). Completes with that list; fails with a [TimeoutException] when none arrives in [wait].
  Future<List<HostWindow>> refreshWindows({
    Duration wait = const Duration(seconds: 10),
  }) async {
    if (isClosed) throw ChannelError('the channel is closed');
    final next = _windows.stream.first;
    final old = _host;
    _listenHost();
    old.close(normalClose);
    return next.timeout(wait);
  }

  void _sendFrame(Uint8List frame) {
    _sending = _sending.then((_) async {
      if (_closed.isCompleted) return;
      _ws.sink.add(await _tx.encrypt(frame));
    });
  }

  Future<void> _receive(Uint8List bytes) async {
    final Uint8List plain;
    try {
      plain = await _rx.decrypt(bytes);
    } on NoiseError {
      // a message that fails to decrypt ends the channel (CHANNEL.md)
      await _ws.sink.close();
      return;
    }
    _mux.receive(plain);
    if (_mux.failed) await _ws.sink.close();
  }

  void _ended(int code) {
    if (_closed.isCompleted) return;
    _mux.closeAll(unreachable);
    _windows.close();
    _closed.complete(code);
  }

  /// The windows the host lists: the last list first (when one has arrived), then every change.
  Stream<List<HostWindow>> get windows async* {
    final last = _last;
    if (last != null) yield last;
    yield* _windows.stream;
  }

  List<HostWindow>? get lastWindows => _last;

  /// Completes with the relay's close code (0 when there was none) once the channel is gone.
  Future<int> get closed => _closed.future;

  bool get isClosed => _closed.isCompleted;

  /// A WebSocket to a window's [path] (`/ws?tab=…`), as a browser tab opens it.
  MuxStream ws(int port, String path) =>
      _mux.open({'kind': 'ws', 'port': port, 'path': path});

  /// One request to a window. Fails with [StreamClosed] when the host closes the stream instead of answering.
  Future<HttpAnswer> http(
    int port,
    String method,
    String path, {
    Map<String, String>? headers,
    List<int>? body,
  }) async {
    final a = await httpStream(
      port,
      method,
      path,
      headers: headers,
      body: body,
    );
    final parts = BytesBuilder(copy: false);
    await a.body.forEach(parts.add);
    return (status: a.status, headers: a.headers, body: parts.takeBytes());
  }

  /// One request to a window, its body read as it arrives (see [streamAnswer]).
  Future<HttpStreamAnswer> httpStream(
    int port,
    String method,
    String path, {
    Map<String, String>? headers,
    List<int>? body,
  }) {
    final pass = {
      for (final e in (headers ?? const <String, String>{}).entries)
        if (passedHeaders.contains(e.key.toLowerCase()))
          e.key.toLowerCase(): e.value,
    };
    final s = _mux.open({
      'kind': 'http',
      'port': port,
      'method': method,
      'path': path,
      if (pass.isNotEmpty) 'headers': pass,
    });
    if (body != null && body.isNotEmpty) {
      unawaited(s.send(body).catchError((_) {}));
    }
    s.end();
    return streamAnswer(s);
  }

  Future<void> close() async {
    await _ws.sink.close();
    await closed.timeout(
      const Duration(seconds: 5),
      onTimeout: () {
        _ended(0);
        return 0;
      },
    );
  }
}
