// The phone's own key and the hosts it is paired with. The key is made once and never leaves the vault.
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:nb_channel/nb_channel.dart' hide fingerprint;
import 'package:nb_channel/nb_channel.dart' as nb show fingerprint;

import 'vault.dart';

class Identity {
  Identity._(this.key);
  final KeyPair key;

  static const _slot = 'nb.identity';

  static Future<Identity> load(Vault v) async {
    final s = await v.read(_slot);
    if (s == null) {
      final key = await generateKeyPair();
      await v.write(_slot, b64u(key.priv));
      return Identity._(key);
    }
    final Uint8List priv;
    try {
      priv = fromB64u(s, 32);
    } on FormatException {
      throw VaultCorrupt(_slot);
    }
    return Identity._((priv: priv, pub: await publicOf(priv)));
  }

  Future<String> get fingerprint => nb.fingerprint(key.pub);
}

class PairedHost {
  PairedHost({
    required this.id,
    required this.relay,
    required this.label,
    required this.pairedAt,
  });

  factory PairedHost.fromJson(Map<String, Object?> j) => PairedHost(
    id: j['id'] as String,
    relay: Uri.parse(j['relay'] as String),
    label: j['label'] as String,
    pairedAt: DateTime.parse(j['pairedAt'] as String),
  );

  /// The host's static public key, base64url (also the relay's host id).
  final String id;
  final Uri relay;

  /// What the list calls this host: the folder of its first window, until renamed.
  final String label;
  final DateTime pairedAt;

  Uint8List get pub => fromB64u(id, 32);

  Map<String, Object?> toJson() => {
    'id': id,
    'relay': '$relay',
    'label': label,
    'pairedAt': pairedAt.toUtc().toIso8601String(),
  };
}

class Hosts extends ChangeNotifier {
  Hosts._(this._v, this._all, this._lastChat);

  final Vault _v;
  final List<PairedHost> _all;
  String? _lastChat;

  static const _slot = 'nb.hosts';
  static const _lastSlot = 'nb.lastChat';

  static Future<Hosts> load(Vault v) async {
    final list = <PairedHost>[];
    final s = await v.read(_slot);
    if (s != null) {
      try {
        for (final e in jsonDecode(s) as List) {
          list.add(PairedHost.fromJson((e as Map).cast<String, Object?>()));
        }
      } on Object {
        // unreadable: start empty and leave the stored text alone until the next change
        list.clear();
      }
    }
    return Hosts._(v, list, await v.read(_lastSlot));
  }

  List<PairedHost> get all => List.unmodifiable(_all);

  PairedHost? byId(String id) => _all.where((h) => h.id == id).firstOrNull;

  /// `hostId port root` of the chat opened last on this phone.
  String? get lastChat => _lastChat;

  Future<void> _save() async {
    await _v.write(_slot, jsonEncode([for (final h in _all) h.toJson()]));
    notifyListeners();
  }

  /// Adds a host, or replaces the one with the same id in place.
  Future<void> add(PairedHost h) async {
    final i = _all.indexWhere((e) => e.id == h.id);
    if (i < 0) {
      _all.add(h);
    } else {
      _all[i] = h;
    }
    await _save();
  }

  Future<void> forget(String id) async {
    _all.removeWhere((e) => e.id == id);
    if (_lastChat?.split(' ').first == id) await setLastChat(null);
    await _save();
  }

  Future<void> setLastChat(String? chat) async {
    _lastChat = chat;
    if (chat == null) {
      await _v.delete(_lastSlot);
    } else {
      await _v.write(_lastSlot, chat);
    }
  }
}
