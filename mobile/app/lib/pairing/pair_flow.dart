// Pairing with a host from the QR of `nota-bene remote pair` (server/src/remote/CHANNEL.md, Pairing): the relay ticket
// and the proof bound to this phone's key go in the first connection; the host then lists the phone for good.
import 'dart:async';
import 'dart:typed_data';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:nb_channel/nb_channel.dart';

import '../store/hosts.dart';

typedef ChannelFactory =
    Future<Channel> Function({
      required Uri relay,
      required Uint8List hostPub,
      required KeyPair key,
      Uint8List? ticket,
      Map<String, Object?> hello,
    });

/// The app's real factory.
Future<Channel> connectChannel({
  required Uri relay,
  required Uint8List hostPub,
  required KeyPair key,
  Uint8List? ticket,
  Map<String, Object?> hello = const {'v': 1},
}) => Channel.connect(
  relay: relay,
  hostPub: hostPub,
  key: key,
  ticket: ticket,
  hello: hello,
);

enum PairError { notACode, codeUsed, unreachable }

sealed class PairResult {}

class Paired extends PairResult {
  Paired(this.host, this.hostFingerprint, this.phoneFingerprint);
  final PairedHost host;
  final String hostFingerprint, phoneFingerprint;
}

class PairFailed extends PairResult {
  PairFailed(this.reason);
  final PairError reason;
}

/// What the host's device list shows for this phone.
Future<String> deviceName() async {
  try {
    final a = await DeviceInfoPlugin().androidInfo;
    if (a.model.trim().isNotEmpty) return a.model.trim();
  } on Object {
    // not Android, or the platform did not answer
  }
  return 'Android phone';
}

/// What the camera may pair with: Nota Bene codes, and not the one that just failed (the camera keeps seeing it).
class ScanGate {
  String? _failed;

  bool accept(String code) => code.startsWith('nbremote://') && code != _failed;

  void failed(String code) => _failed = code;
}

class PairFlow {
  PairFlow(
    this._connect,
    this._identity,
    this._hosts, {
    void Function(String hostId)? pause,
    void Function(String hostId)? resume,
  }) : _pause = pause,
       _resume = resume;

  final ChannelFactory _connect;
  final Identity _identity;
  final Hosts _hosts;

  /// The host's own link, stopped while the pairing connection (the same key) is up.
  final void Function(String hostId)? _pause, _resume;

  /// Pairs with the host of [qr]. Pairing a host again (its list lost this phone, say) replaces the saved one.
  Future<PairResult> pair(
    String qr, {
    required String deviceName,
    Duration windowsWait = const Duration(seconds: 3),
  }) async {
    final ({Uri relay, Uint8List hostPub, Uint8List secret}) code;
    try {
      code = parsePairUri(qr.trim());
    } on FormatException {
      return PairFailed(PairError.notACode);
    }
    final key = _identity.key;
    final hostId = b64u(code.hostPub);
    _pause?.call(hostId);
    try {
      return await _pairWith(code, key, deviceName, windowsWait);
    } finally {
      _resume?.call(hostId);
    }
  }

  Future<PairResult> _pairWith(
    ({Uri relay, Uint8List hostPub, Uint8List secret}) code,
    KeyPair key,
    String deviceName,
    Duration windowsWait,
  ) async {
    final Channel ch;
    try {
      ch = await _connect(
        relay: code.relay,
        hostPub: code.hostPub,
        key: key,
        ticket: await pairTicket(code.secret),
        hello: {
          'v': 1,
          'name': deviceName,
          'pair': b64u(await pairProof(code.secret, key.pub)),
        },
      );
    } on ChannelError catch (e) {
      return PairFailed(
        e.relayCode == 4403 ? PairError.codeUsed : PairError.unreachable,
      );
    }
    final hostFp = await fingerprint(code.hostPub);
    String label = hostFp.substring(0, 9);
    final computer = ch.hostName;
    if (computer == null) {
      // an older host sends no name: the folder of its first window labels it
      try {
        final list = await ch.windows
            .firstWhere((l) => l.isNotEmpty)
            .timeout(windowsWait);
        label = _folder(list.first.root);
      } on Object {
        // no window yet: the fingerprint names the host until one opens
      }
    }
    await ch.close();
    final host = PairedHost(
      id: b64u(code.hostPub),
      relay: code.relay,
      label: label,
      computerName: computer,
      pairedAt: DateTime.now(),
    );
    await _hosts.add(host);
    return Paired(host, hostFp, await _identity.fingerprint);
  }
}

String _folder(String root) {
  final parts = root.split(RegExp(r'[\\/]')).where((p) => p.isNotEmpty);
  return parts.isEmpty ? root : parts.last;
}
