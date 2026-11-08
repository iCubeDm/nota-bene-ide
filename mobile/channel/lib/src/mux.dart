// The stream frames of server/src/remote/CHANNEL.md, phone side: a port of server/src/remote/mux.ts. The phone opens
// every stream (odd ids from 1); received DATA is reassembled into whole messages, and credit goes back as the
// listener takes them, so a phone that stops reading throttles the host instead of filling memory.
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

const open_ = 1, head_ = 2, data_ = 3, end_ = 4, close_ = 5, credit_ = 6;
const fin_ = 1, bin_ = 2;

const streamWindow = 256 * 1024;
const connWindow = 512 * 1024;
const maxChunk = 65535 - 16 - 6;
const maxStreams = 64;
const maxCollect = 64 * 1024 * 1024;

const normalClose = 1000; // both sides ended normally
const badFrame = 4900;
const unreachable = 4902;
const unknownWindow = 4904;
const tooLarge = 4913;
const tooMany = 4929;

class MuxError implements Exception {
  MuxError(this.message);
  final String message;
  @override
  String toString() => 'MuxError: $message';
}

/// What a stream's futures fail with once it is over.
class StreamClosed implements Exception {
  StreamClosed(this.code, [this.reason]);
  final int code;
  final String? reason;
  @override
  String toString() =>
      'StreamClosed($code${reason == null ? '' : ', $reason'})';
}

sealed class Frame {
  const Frame(this.stream);
  final int stream;
}

class Open extends Frame {
  const Open(super.stream, this.json);
  final Object? json;
}

class Head extends Frame {
  const Head(super.stream, this.json);
  final Object? json;
}

class Data extends Frame {
  const Data(super.stream, this.data, {this.fin = false, this.binary = false});
  final List<int> data;
  final bool fin;
  final bool binary;
}

class End extends Frame {
  const End(super.stream);
}

class Close extends Frame {
  const Close(super.stream, this.code, [this.reason]);
  final int code;
  final String? reason;
}

class Credit extends Frame {
  const Credit(super.stream, this.n);
  final int n;
}

Uint8List encodeFrame(Frame f) {
  final (type, flags, body) = switch (f) {
    Open(:final json) => (open_, 0, utf8.encode(jsonEncode(json ?? {}))),
    Head(:final json) => (head_, 0, utf8.encode(jsonEncode(json ?? {}))),
    Data(:final data, :final fin, :final binary) => (
      data_,
      (fin ? fin_ : 0) | (binary ? bin_ : 0),
      data,
    ),
    End() => (end_, 0, const <int>[]),
    Close(:final code, :final reason) => (
      close_,
      0,
      utf8.encode(jsonEncode({'code': code, 'reason': ?reason})),
    ),
    Credit(:final n) => (
      credit_,
      0,
      (ByteData(4)..setUint32(0, n)).buffer.asUint8List(),
    ),
  };
  final out = Uint8List(6 + body.length);
  out[0] = type;
  ByteData.sublistView(out).setUint32(1, f.stream);
  out[5] = flags;
  out.setRange(6, out.length, body);
  return out;
}

Frame decodeFrame(Uint8List b) {
  if (b.length < 6) throw MuxError('frame too short');
  final type = b[0], flags = b[5];
  final stream = ByteData.sublistView(b).getUint32(1);
  final body = Uint8List.sublistView(b, 6);
  Object? json() {
    try {
      return jsonDecode(utf8.decode(body));
    } on FormatException {
      throw MuxError('bad JSON in a frame');
    }
  }

  switch (type) {
    case data_:
      return Data(
        stream,
        body,
        fin: flags & fin_ != 0,
        binary: flags & bin_ != 0,
      );
    case end_:
      return End(stream);
    case credit_:
      if (body.length != 4) throw MuxError('bad credit frame');
      return Credit(stream, ByteData.sublistView(body).getUint32(0));
    case open_:
      return Open(stream, json());
    case head_:
      return Head(stream, json());
    case close_:
      final j = json();
      final code = j is Map ? j['code'] : null;
      final reason = j is Map ? j['reason'] : null;
      return Close(
        stream,
        code is int ? code : badFrame,
        reason is String ? reason : null,
      );
    default:
      throw MuxError('unknown frame type $type');
  }
}

typedef Message = ({Uint8List data, bool binary});

class _Out {
  _Out(this.data, this.flags, this.done);
  List<int> data;
  final int flags;
  final Completer<void>? done; // on the message's last chunk
}

/// One stream of the channel.
class MuxStream {
  MuxStream._(this._mux, this.id) {
    // before the first listener the controller counts as paused: what arrived until then is granted on listen
    _messages = StreamController<Message>(
      onListen: _flushGrants,
      onResume: _flushGrants,
    );
    _head.future.ignore();
  }

  final Mux _mux;
  final int id;
  late final StreamController<Message> _messages;
  final _head = Completer<Map<String, Object?>>();
  final _closed = Completer<({int code, String? reason})>();
  int _sendCredit = streamWindow;
  int _recvWindow = streamWindow;
  int _consumed = 0;
  int _held = 0; // bytes received while the listener paused: granted on resume
  final _out = <_Out>[];
  bool _endWanted = false, _endSent = false, _remoteEnded = false;
  bool _isClosed = false;
  final _parts = BytesBuilder(copy: false);

  /// Whole messages, in order; done when the stream is over.
  Stream<Message> get messages => _messages.stream;

  /// The response head; fails with [StreamClosed] if the stream ends first.
  Future<Map<String, Object?>> get head => _head.future;

  Future<({int code, String? reason})> get closed => _closed.future;

  bool get isClosed => _isClosed;

  /// DATA bytes waiting for credit.
  int get queuedBytes => _out.fold(0, (n, o) => n + o.data.length);

  /// Queues one message, split into chunks; completes once its last chunk has gone out.
  Future<void> send(List<int> data, {bool binary = false}) {
    if (_isClosed || _endWanted) {
      return Future.error(
        StreamClosed(_isClosed ? -1 : normalClose, 'not writable'),
      );
    }
    final bin = binary ? bin_ : 0;
    final done = Completer<void>();
    if (data.isEmpty) _out.add(_Out(const [], fin_ | bin, done));
    for (var i = 0; i < data.length; i += maxChunk) {
      final end = i + maxChunk < data.length ? i + maxChunk : data.length;
      final last = end == data.length;
      _out.add(
        _Out(data.sublist(i, end), (last ? fin_ : 0) | bin, last ? done : null),
      );
    }
    _pump();
    return done.future;
  }

  /// No more DATA from this side (sent once the queue has drained).
  void end() {
    if (_isClosed || _endWanted) return;
    _endWanted = true;
    _pump();
  }

  void close(int code, [String? reason]) {
    if (_isClosed) return;
    _mux._sendFrame(Close(id, code, reason));
    _gone(code, reason);
  }

  void _pump() {
    while (!_isClosed && _out.isNotEmpty) {
      final o = _out.first;
      if (o.data.isEmpty) {
        _mux._sendFrame(
          Data(
            id,
            const [],
            fin: o.flags & fin_ != 0,
            binary: o.flags & bin_ != 0,
          ),
        );
        _out.removeAt(0);
        o.done?.complete();
        continue;
      }
      final allowed = _sendCredit < _mux._sendCredit
          ? _sendCredit
          : _mux._sendCredit;
      if (allowed <= 0) return;
      final take = allowed < o.data.length ? allowed : o.data.length;
      final last = take == o.data.length;
      _mux._sendFrame(
        Data(
          id,
          last ? o.data : o.data.sublist(0, take),
          fin: last && o.flags & fin_ != 0,
          binary: o.flags & bin_ != 0,
        ),
      );
      _sendCredit -= take;
      _mux._sendCredit -= take;
      if (last) {
        _out.removeAt(0);
        o.done?.complete();
      } else {
        o.data = o.data.sublist(take);
      }
    }
    if (_isClosed || _out.isNotEmpty) return;
    if (_endWanted && !_endSent) {
      _endSent = true;
      _mux._sendFrame(End(id));
      _maybeFinish();
    }
  }

  void _credit(int n) {
    _sendCredit += n;
    _pump();
  }

  void _data(Data f) {
    if (_isClosed) return;
    _parts.add(f.data);
    if (_parts.length > _mux._maxMessage) {
      _parts.clear();
      _grant(f.data.length);
      close(tooLarge, 'message too large');
      return;
    }
    if (f.fin) _messages.add((data: _parts.takeBytes(), binary: f.binary));
    _grant(f.data.length);
  }

  void _grant(int n) {
    if (_messages.isPaused && !_isClosed) {
      _held += n;
      return;
    }
    _mux._consumed(n);
    if (_isClosed || _remoteEnded) return;
    _consumed += n;
    if (_consumed >= streamWindow ~/ 2) {
      _recvWindow += _consumed;
      _mux._sendFrame(Credit(id, _consumed));
      _consumed = 0;
    }
  }

  void _flushGrants() {
    final n = _held;
    _held = 0;
    if (n > 0) _grant(n);
  }

  void _remoteEnd() {
    _remoteEnded = true;
    _maybeFinish();
  }

  void _maybeFinish() {
    if (_endSent && _remoteEnded && !_isClosed) _gone(normalClose);
  }

  /// The stream is over: no frame is sent. Bytes never granted still hold connection credit and are given back.
  void _gone(int code, [String? reason]) {
    if (_isClosed) return;
    _isClosed = true;
    for (final o in _out) {
      o.done?.completeError(StreamClosed(code, reason));
      o.done?.future.ignore();
    }
    _out.clear();
    _parts.clear();
    final held = _held;
    _held = 0;
    if (held > 0) _mux._consumed(held);
    _mux._forget(this);
    if (!_head.isCompleted) _head.completeError(StreamClosed(code, reason));
    _closed.complete((code: code, reason: reason));
    _messages.close();
  }
}

/// One per channel, phone side. [send] gets each encoded frame (one Noise transport message).
class Mux {
  Mux(this._send, {int maxMessage = maxCollect}) : _maxMessage = maxMessage;

  final void Function(Uint8List frame) _send;
  final int _maxMessage;
  final _streams = <int, MuxStream>{};
  int _nextId = 1;
  bool _failed = false;
  int _sendCredit = connWindow;
  int _recvWindow = connWindow;
  int _consumedTotal = 0;

  bool get failed => _failed;
  int get size => _streams.length;

  void _sendFrame(Frame f) {
    if (!_failed) _send(encodeFrame(f));
  }

  /// Opens a stream; the 65th open one is closed at once with 4929 and never sent.
  MuxStream open(Map<String, Object?> body) {
    final s = MuxStream._(this, _nextId);
    _nextId += 2;
    if (_failed) {
      s._gone(unreachable);
      return s;
    }
    if (_streams.length >= maxStreams) {
      s._gone(tooMany);
      return s;
    }
    _streams[s.id] = s;
    _sendFrame(Open(s.id, body));
    return s;
  }

  void receive(Uint8List frame) {
    if (_failed) return;
    final Frame f;
    try {
      f = decodeFrame(frame);
    } on MuxError {
      fail(badFrame);
      return;
    }
    final s = _streams[f.stream];
    switch (f) {
      case Open():
        _sendFrame(
          Close(f.stream, badFrame, 'streams are opened by the phone'),
        );
      case Data():
        if (f.data.length > _recvWindow ||
            (s != null && f.data.length > s._recvWindow)) {
          fail(badFrame);
          return;
        }
        _recvWindow -= f.data.length;
        if (s == null) {
          _consumed(
            f.data.length,
          ); // a stream that just closed: its bytes still count
          return;
        }
        s._recvWindow -= f.data.length;
        s._data(f);
      case End():
        s?._remoteEnd();
      case Head(:final json):
        if (s != null && !s._head.isCompleted) {
          s._head.complete(
            json is Map ? json.cast<String, Object?>() : <String, Object?>{},
          );
        }
      case Close(:final code, :final reason):
        s?._gone(code, reason);
      case Credit(:final n):
        if (f.stream == 0) {
          _sendCredit += n;
          for (final x in [..._streams.values]) {
            if (x._out.isNotEmpty) x._pump();
          }
        } else {
          s?._credit(n);
        }
    }
  }

  void _consumed(int n) {
    if (_failed) return;
    _consumedTotal += n;
    if (_consumedTotal >= connWindow ~/ 2) {
      _recvWindow += _consumedTotal;
      _sendFrame(Credit(0, _consumedTotal));
      _consumedTotal = 0;
    }
  }

  void _forget(MuxStream s) {
    if (identical(_streams[s.id], s)) _streams.remove(s.id);
  }

  /// A protocol violation: every stream closes with [code]; the channel's owner drops the connection.
  void fail(int code) {
    if (_failed) return;
    closeAll(code);
  }

  /// The channel is gone: every stream closes locally with [code]; nothing is sent.
  void closeAll(int code, [String? reason]) {
    _failed = true;
    for (final s in [..._streams.values]) {
      s._gone(code, reason);
    }
  }
}
